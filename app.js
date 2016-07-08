'use strict';

// modules requirements
const
    bodyParser = require('body-parser'),
    crypto = require('crypto'),
    express = require('express'),
    fetch = require('node-fetch'),
    request = require('request'),
    https = require('https'),
    config = require('config');

// Wit variables
let
    Wit = require('node-wit').Wit,
    log = require('node-wit').log;

const PORT = process.env.PORT || config.get('port'), // web-server parameter
    WIT_TOKEN = process.env.WIT_TOKEN || config.get('witToken'), // wit.ai parameter
    FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_TOKEN || config.get('pageAccessToken'), // facebook page access token
    FB_APP_SECRET = process.env.FB_APP_SECRET || config.get('appSecret'), // facebook app secret
    FB_VALIDATION_TOKEN = config.get('validationToken'); // facebook validation token

// if don't have all necessary parameters - exit
if (!(FB_APP_SECRET && FB_PAGE_ACCESS_TOKEN && FB_VALIDATION_TOKEN && WIT_TOKEN && PORT)) {
    console.error('Missing config values');
    process.exit(1);
}

// emergency type guidelines

const guidelines = {
    extinguisher_usage: {
        "title": "Extinguisher usage",
        "image_url": "http://www.fireonline.com.au/resources/products/howtooperateanextinguisher.jpg",
        "buttons": [
            {
                "type": "postback",
                "title": "See instructions",
                "payload": "extinguisher_usage"
            }
        ]
    },
    first_fire_action: {
        "title": "First fire action",
        "image_url": "http://image.shutterstock.com/z/stock-vector-fire-action-emergency-procedure-do-not-panic-call-fire-brigade-leave-by-nearest-emergency-exit-246972229.jpg",
        "buttons": [
            {
                "type": "postback",
                "title": "What to do?",
                "payload": "first_fire_action"
            }
        ]
    },
    heimlich_maneuver: {
        "title": "Heimlich Maneuver instructions",
        "image_url": "http://preparednessadvice.com/wp-content/uploads/2016/05/2002_Heimlich.jpg",
        "buttons": [
            {
                "type": "postback",
                "title": "I need this right now",
                "payload": "heimlich_maneuver"
            }
        ]
    },
    cpr: {
        "title": "Adult CPR instruction",
        "image_url": "https://s-media-cache-ak0.pinimg.com/564x/c1/e7/91/c1e791049ab72ec664a0f8c02362d4c7.jpg",
        "buttons": [
            {
                "type": "postback",
                "title": "How to do cpr",
                "payload": "cpr"
            }
        ]
    },
    car_accident_first_steps: {
        "title": "First steps after car accident",
        "image_url": "http://thumbnails-visually.netdna-ssl.com/what-to-do-after-a-car-accident_53c65b0b887ca_w1500.png",
        "buttons": [
            {
                "type": "postback",
                "title": "What should I do?",
                "payload": "car_accident_first_steps"
            }
        ]
    },
    crime_stoppers: {
        "title": "You can report crime quickly!",
        "item_url": "http://www.canadiancrimestoppers.org/home",
        "image_url": "http://www.bccrimestoppers.com/images/partner-logos/ccs.jpg",
        "subtitle": "Tap the image to make a report"
    },
};

const guidelinesByType = {
    "fire": [guidelines.extinguisher_usage, guidelines.first_fire_action],
    "medical": [guidelines.cpr, guidelines.heimlich_maneuver],
    "carAccident": [guidelines.car_accident_first_steps],
    "crime": [guidelines.crime_stoppers]
};

// ----------------------------------------------------------------------------
// Messenger API specific code

const receivedMessage = (event) => {
    const senderID = event.sender.id;
    const recipientID = event.recipient.id;
    const timeOfMessage = event.timestamp;
    const {text, attachments} = event.message;
    const sessionId = findOrCreateSession(senderID);

    console.log("Received message for user %d and page %d at %d with message:",
        senderID, recipientID, timeOfMessage);
    console.log(JSON.stringify(text));

    if (attachments) {
        attachments.forEach(attachment => {
            switch (attachment.type) {
                case 'location':
                    let coordinates =
                        attachment.payload.coordinates.lat
                        + ',' + attachment.payload.coordinates.long;

                    wit.runActions(
                        sessionId,
                        coordinates,
                        sessions[sessionId].context
                    ).then((context) => {
                        console.log('Waiting for next user messages');

                        sessions[sessionId].context = context;
                    }).catch((err) => {
                        console.error('Oops! Got an error from Wit: ', err.stack || err);
                    });
                    break;
                default:
                    sendTextMessage(senderID,
                        'Sorry I cannot handle this type of attachment for now: ', attachment.type)
                        .catch(console.error);
            }
        });
    } else if (text) {
        // We received a text message

        // Let's forward the message to the Wit.ai Bot Engine
        // This will run all actions until our bot has nothing left to do
        wit.runActions(
            sessionId, // the user's current session
            text, // the user's message
            sessions[sessionId].context // the user's current session state
        ).then((context) => {
            // Our bot did everything it has to do.
            // Now it's waiting for further messages to proceed.
            console.log('Waiting for next user messages');

            // Based on the session state, you might want to reset the session.
            // This depends heavily on the business logic of your bot.
            // Example:
            // if (context['done']) {
            //   delete sessions[sessionId];
            // }

            // Updating the user's current session state
            sessions[sessionId].context = context;
        }).catch((err) => {
            console.error('Oops! Got an error from Wit: ', err.stack || err);
        })
    }
};

const receivedAuthentication = (event) => {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfAuth = event.timestamp;

    // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
    // The developer can set this to an arbitrary value to associate the
    // authentication callback with the 'Send to Messenger' click event. This is
    // a way to do account linking when the user clicks the 'Send to Messenger'
    // plugin.
    var passThroughParam = event.optin.ref;

    console.log("Received authentication for user %d and page %d with pass " +
        "through param '%s' at %d", senderID, recipientID, passThroughParam,
        timeOfAuth);

    // When an authentication is received, we'll send a message back to the sender
    // to let them know it was successful.
    sendTextMessage(senderID, "Authentication successful");
};

const receivedDeliveryConfirmation = (event) => {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var delivery = event.delivery;
    var messageIDs = delivery.mids;
    var watermark = delivery.watermark;
    var sequenceNumber = delivery.seq;

    if (messageIDs) {
        messageIDs.forEach(function (messageID) {
            console.log("Received delivery confirmation for message ID: %s",
                messageID);
        });
    }

    console.log("All message before %d were delivered.", watermark);
};

const receivedPostback = (event) => {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfPostback = event.timestamp;

    // The 'payload' param is a developer-defined field which is set in a postback
    // button for Structured Messages.
    var payload = event.postback.payload;

    console.log("Received postback for user %d and page %d with payload '%s' " +
        "at %d", senderID, recipientID, payload, timeOfPostback);

    // When a postback is called, we'll send a message back to the sender to
    // let them know it was successful
    if (guidelines[payload]) {
        sendImageMessage(senderID, guidelines[payload].image_url);
    } else {
        sendTextMessage(senderID, {text: "Cannot handle your postback"});
    }
};

const sendTextMessage = (recipientId, response) => {
    let body = {
        recipient: {
            id: recipientId
        },
        message: {
            text: response.text
        }
    };
    // adding quick replies
    if (response.quickreplies) {
        body.message.quick_replies = [];
        response.quickreplies.forEach(quickreply => {
            body.message.quick_replies.push({
                "content_type": "text",
                "title": quickreply,
                "payload": "some_payload"
            });
        });
    }
    body = JSON.stringify(body);

    return callSendAPI(body);
};

const sendGenericMessage = (recipientId, elements) => {
    let body = JSON.stringify({
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "generic",
                    elements: elements
                }
            }
        }
    });

    return callSendAPI(body);
};

function sendButtonMessage(recipientId, buttons) {
    var body = JSON.stringify({
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    "text": "The nearest locations list",
                    template_type: "button",
                    buttons: buttons
                }
            }
        }
    });

    return callSendAPI(body);
}

function sendImageMessage(recipientId, image_url) {
    var body = JSON.stringify({
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "image",
                payload: {
                    url: image_url
                }
            }
        }
    });

    return callSendAPI(body);
}

function callSendAPI(body) {
    const qs = 'access_token=' + encodeURIComponent(FB_PAGE_ACCESS_TOKEN);

    return fetch('https://graph.facebook.com/me/messages?' + qs, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body
    })
        .then(rsp => rsp.json())
        .then(json => {
            if (json.error && json.error.message) {
                throw new Error(json.error.message);
            }
            return json;
        });
}

// ----------------------------------------------------------------------------
// Wit.ai bot specific code

// This will contain all user sessions.
// Each session has an entry:
// sessionId -> {fbid: facebookUserId, context: sessionState}
const sessions = {};

const findOrCreateSession = (fbid) => {
    let sessionId;
    // Let's see if we already have a session for the user fbid
    Object.keys(sessions).forEach(k => {
        if (sessions[k].fbid === fbid) {
            // Yep, got it!
            sessionId = k;
        }
    });
    if (!sessionId) {
        // No session found for user fbid, let's create a new one
        sessionId = new Date().toISOString();
        sessions[sessionId] = {fbid: fbid, context: {}};
    }
    return sessionId;
};

const firstEntityValue = (entities, entity) => {
    const val = entities && entities[entity] &&
        Array.isArray(entities[entity]) &&
        entities[entity].length > 0 &&
        entities[entity][0].value;

    if (!val) {
        return null;
    }

    return typeof val === 'object' ? val.value : val;
};

// Our bot actions
const actions = {
    send(request, response) {
        const {sessionId, context, entities} = request;
        // const {text, quickreplies} = response;

        // Our bot has something to say!
        // Let's retrieve the Facebook user whose session belongs to
        const recipientId = sessions[sessionId].fbid;
        if (recipientId) {
            // Yay, we found our recipient!
            // Let's forward our bot response to him.
            // We return a promise to let our bot know when we're done sending
            return sendTextMessage(recipientId, response)
                .then(() => null)
                .catch((err) => {
                    console.error(
                        'Oops! An error occurred while forwarding the response to',
                        recipientId,
                        ':',
                        err.stack || err
                    );
                });
        } else {
            console.error('Oops! Couldn\'t find user for session:', sessionId);
            // Giving the wheel back to our bot
            return Promise.resolve()
        }
    },
    prepareNewRequest(request) {
        console.log('"Prepare new request" request:\n', request);
        const {sessionId, context, entities} = request;

        return new Promise((resolve, reject) => {
            Object.keys(context).forEach(function (key) {
                delete context[key];
            });

            console.log('"Prepare new request" response:\n', context);
            return resolve(context);
        });
    },
    getEmergencyType(request) {
        console.log("Get emergency type request:\n", request);
        const {sessionId, context, entities} = request;

        return new Promise((resolve, reject) => {
            let emergencyType = firstEntityValue(entities, 'emergencyType');

            if (emergencyType) {
                context.emergencyType = emergencyType;
                delete context.missingEmergencyType;
            } else {
                context.missingEmergencyType = true;
                delete context.emergencyType;
            }

            console.log("Get emergency type response:\n", context);
            return resolve(context);
        });
    },
    getLocation(request) {
        console.log("Get location request:\n", request);
        const {sessionId, context, entities} = request;

        return new Promise((resolve, reject) => {
            let location = firstEntityValue(entities, 'location');

            if (location) {
                context.location = location;
                delete context.missingLocation;
            } else {
                context.missingLocation = true;
                delete context.location;
            }

            console.log("Get location response:\n", context);
            return resolve(context);
        });
    },
    getDatetime(request) {
        console.log("Get datetime request:\n", request);
        const {sessionId, context, entities} = request;

        return new Promise((resolve, reject) => {
            let datetime = firstEntityValue(entities, 'datetime');

            if (datetime) {
                context.datetime = datetime;
                delete context.missingDatetime;
            } else {
                context.missingDatetime = true;
                delete context.datetime;
            }

            console.log("Get datetime response:\n", context);
            return resolve(context);
        });
    },
    sendGuidelinesList(request) {
        console.log("Send guidelines request:\n", request);
        const {sessionId, context, entities} = request;
        const recipientId = sessions[sessionId].fbid;

        if (recipientId) {
            return sendGenericMessage(recipientId, guidelinesByType[context.emergencyType])
                .then(() => null)
                .catch((err) => {
                    console.error(
                        'Oops! An error occurred while sending generic message the response to',
                        recipientId,
                        ':',
                        err.stack || err
                    );
                });
        } else {
            console.error('Oops! Couldn\'t find user for session:', sessionId);
            return Promise.resolve()
        }
    },
    sendNearest(request) {
        console.log("Find nearest:\n", request);
        const {sessionId, context, entities} = request;
        const recipientId = sessions[sessionId].fbid;

        if (recipientId) {
            let searchQuery = 'https://www.google.ca/maps/search/' + context.locationToFind +
                '+near+me/@' + context.location;

            let buttons = [
                {
                    "type": "web_url",
                    "url": searchQuery,
                    "title": "Show nearest " + context.locationToFind
                }
            ];

            delete context.location;
            delete context.locationToFind;

            return sendButtonMessage(recipientId, buttons)
                .then(() => null)
                .catch((err) => {
                    console.error(
                        'Oops! An error occurred while sending button message the response to',
                        recipientId,
                        ':',
                        err.stack || err
                    );
                });
        } else {
            console.error('Oops! Couldn\'t find user for session:', sessionId);
            return Promise.resolve()
        }
    },
    getLocationToFind (request) {
        console.log("Get location to find request:\n", request);
        const {sessionId, context, entities} = request;

        return new Promise((resolve, reject) => {
            let locationToFind = firstEntityValue(entities, 'location');

            if (locationToFind) {
                context.locationToFind = locationToFind;
                delete context.missingLocationToFind;
            } else {
                context.missingLocationToFind = true;
                delete context.locationToFind;
            }

            console.log("Get location to find response:\n", context);
            return resolve(context);
        });
    }
};

// Setting up our bot
const wit = new Wit({
    accessToken: WIT_TOKEN,
    actions,
    logger: new log.Logger(log.INFO)
});

// Starting our web-server and putting it all together
const app = express();
app.use(({method, url}, rsp, next) => {
    rsp.on('finish', () => {
        console.log(`${rsp.statusCode} ${method} ${url}`);
    });
    next();
});
app.use(bodyParser.json({verify: verifyRequestSignature}));
app.use(express.static('public'));

// Webhook setup
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' &&
        req.query['hub.verify_token'] === FB_VALIDATION_TOKEN) {
        console.log("Validating webhook");
        res.status(200).send(req.query['hub.challenge']);
    } else {
        console.error("Failed validation. Make sure the validation tokens match.");
        res.sendStatus(403);
    }
});

// Message handler
app.post('/webhook', (req, res) => {
    // Parse the Messenger payload
    const data = req.body;

    if (data.object === 'page') {
        data.entry.forEach(entry => {
            entry.messaging.forEach(messagingEvent => {
                if (messagingEvent.optin) {
                    receivedAuthentication(messagingEvent);
                } else if (messagingEvent.message) {
                    receivedMessage(messagingEvent);
                } else if (messagingEvent.delivery) {
                    receivedDeliveryConfirmation(messagingEvent);
                } else if (messagingEvent.postback) {
                    receivedPostback(messagingEvent);
                } else {
                    console.log("Webhook received unknown messagingEvent: ", messagingEvent);
                }
            });
        });
    }
    res.sendStatus(200);
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 */
function verifyRequestSignature(req, res, buf) {
    var signature = req.headers["x-hub-signature"];

    if (!signature) {
        // For testing, let's log an error. In production, you should throw an
        // error.
        console.error("Couldn't validate the signature.");
    } else {
        var elements = signature.split('=');
        var method = elements[0];
        var signatureHash = elements[1];

        var expectedHash = crypto.createHmac('sha1', FB_APP_SECRET)
            .update(buf)
            .digest('hex');

        if (signatureHash != expectedHash) {
            console.log(signatureHash);
            console.log(expectedHash);
            throw new Error("Couldn't validate the request signature.");
        }
    }
}

app.listen(PORT);
console.log('Listening on :' + PORT + '...');