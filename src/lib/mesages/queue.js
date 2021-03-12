// for provided event and message type
// queues messasges to be sent (messageQueue)
import debug from 'debug';
import * as Sentry from '@sentry/node';
import { dataSources } from '@thatconference/api';
import messagesStore from '../../dataSources/cloudFirestore/messages';
import msgQueueStore from '../../dataSources/cloudFirestore/messageQueue';
import { fetchAddressees } from '../graphql/fetch';
import constants from '../../constants';
import determineSendOnDate from './determineSendOnDate';

const dlog = debug('that:api:communications:messages:queue');
const eventStore = dataSources.cloudFirestore.event;

export default async ({ eventId, messageType, firestore, thatApi }) => {
  dlog('queue messages called');
  Sentry.addBreadcrumb({
    category: 'message queuing',
    message: 'start message queue process for event',
  });
  Sentry.setTags({
    messageQueueEventId: eventId,
    messageQueueMessageType: messageType,
  });
  const event = await eventStore(firestore).get(eventId);
  if (!event) {
    const err = new Error(`Unkown event id provided, ${eventId}`);
    Sentry.captureException(err);
    throw err;
  }
  const eventType = event.type;
  Sentry.setTag('messageQueueEventType', eventType);
  let message = null;
  if (eventType === 'ONLINE') {
    message = await messagesStore(firestore).findOnlineMessageByType(
      messageType,
    );
    // ONLINE messages go for many eventId's lets add eventId for later reference
    if (message && message.length > 0) message[0].event = eventId;
  } else
    message = await messagesStore(firestore).findByEventIdAndType({
      eventId,
      messageType,
    });

  if (!message || (message && message.length < 1)) {
    const err = new Error(
      `Unable to queue messages, no message definition for event type ${eventType}, eventId ${eventId} with messageType ${messageType}`,
    );
    Sentry.captureException(err);
    throw err;
  }
  [message] = message;

  const sendOnDate = determineSendOnDate({
    startDate: event.startDate,
    endDate: event.endDate,
    messageType: message.messageType,
  });

  const addressees = await fetchAddressees({
    eventId,
    msgDataSource: message.dataSource,
    thatApi,
  });
  const totalAddressees = addressees.length;
  dlog('number of addressees %d', totalAddressees);

  // queue messages (refactor this out)
  const queueRate = constants.THAT.MESSAGING.WRITE_QUEUE_RATE;
  dlog('queue rate %d', queueRate);
  const iterations = Math.ceil(totalAddressees / queueRate);
  const messageQueue = [];
  let iterationQueue = [];
  dlog('number of queue iterations: %d', iterations);
  const queueDate = new Date();
  for (let i = 0; i < iterations; i += 1) {
    dlog('on iteration, %d', i);
    iterationQueue = [];
    // when on last iteration use the remander otherwise use the write queue rate
    const jMax = i === iterations - 1 ? totalAddressees % queueRate : queueRate;

    for (let j = 0; j < jMax; j += 1) {
      const addressee = addressees[i * queueRate + j];
      const allocatedTo = addressee.allocatedTo || {};
      const purchasedBy = addressee.purchasedBy || {};

      const msg = {
        // email: allocatedTo.email,
        postmarkAlias: message.postmarkAlias,
        templateModel: {
          member: {
            firstName: allocatedTo.firstName || '',
            lastName: allocatedTo.lastName || '',
            email: allocatedTo.email || '',
          },
          purchasedBy: {
            firstName: purchasedBy.firstName || '',
            lastName: purchasedBy.lastName || '',
            email: purchasedBy.email || '',
          },
          event: {
            name: event.name || '',
            startDate: event.startDate || '',
            endDate: event.endDate || '',
          },
        },
        isQueued: false,
        isSent: false,
        queueDate,
        sendOnDate,
      };

      iterationQueue.push(msg);
    }

    messageQueue.push(iterationQueue);
  }

  // Send each messageQueue array of messages to Firestore via a batch
  let messageCount = 0;
  const queuePromises = messageQueue.map(iq => {
    messageCount += iq.length;
    return msgQueueStore(firestore).addMany(iq);
  });

  dlog('number of messages: %d', messageCount);

  // this is good for efficiency, but not so good if one of the queues fail.
  // the Promise.all will fail, but the requests are already sent to Firestore
  // and may or may not complete.
  // if there are 4 promises, how to determine which messages didn't make it?
  // We can give a queue record a signature so it is idempontent and this can be
  // run again. Assuming nothing has been sent to Postmark yet...

  return Promise.all(queuePromises).then(() => messageCount);
};
