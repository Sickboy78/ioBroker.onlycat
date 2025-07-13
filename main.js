/*********************
 *                   *
 *  OnlyCat Adapter  *
 *                   *
 *********************/

'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
const OnlyCatApi = require('./lib/onlycat-api');

// Constants
// Adapter version
const ADAPTER_VERSION = '0.3.1';
// Reconnect frequency
const RETRY_FREQUENCY_CONNECT = 60;
// Minimum Event Update frequency
const MINIMUM_EVENT_UPDATE_FREQUENCY = 1;
// Maximum Event Updates
const MAX_EVENT_UPDATE = 10;
// Event Trigger
const EVENT_TRIGGER_SOURCE = { 0: 'MANUAL', 1: 'REMOTE', 2: 'INDOOR_MOTION', 3: 'OUTDOOR_MOTION' };
// Event Classification
const EVENT_CLASSIFICATION = {
    0: 'UNKNOWN',
    1: 'CLEAR',
    2: 'SUSPICIOUS',
    3: 'CONTRABAND',
    4: 'HUMAN_ACTIVITY',
    10: 'REMOTE_UNLOCK',
};
// Event Type generated from Trigger + Classification
const EVENT_TYPE = { MANUAL: 0, REMOTE: 1, EXIT: 2, ENTRY: 3, CONTRABAND: 4 };
const EVENT_TYPE_NAME = { 0: 'manual', 1: 'remote', 2: 'exit', 3: 'entry', 4: 'contraband' };
const EVENT_TYPE_MAX = 5;

class Template extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'onlycat',
        });

        this.api = new OnlyCatApi(this);
        this.connectionStatusSubcription = undefined;
        this.userSubscription = undefined;

        // class variables
        // reconnect timer
        this.reconnectTimerId = undefined;
        // event update timer
        this.eventUpdateTimerId = undefined;
        // event update counter
        this.eventUpdateCounter = 0;
        // adapter unloaded indicator
        this.adapterUnloaded = false;
        // last error
        this.lastError = undefined;
        // is automatic reconnecting
        this.reconnecting = false;

        /* current and previous data from OnlyCat API */
        // list of devices
        this.devices = undefined;
        // list of RFIDs
        this.rfids = [];
        // list of RFID profiles
        this.rfidProfiles = {};
        // list of events
        this.events = undefined;
        // list of previous events
        this.lastEvents = undefined;
        // current user
        this.currentUser = undefined;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setConnectionStatusToAdapter(false);

        // check adapter config for invalid values
        this.checkAdapterConfig();

        // subscribe to control state changes
        this.subscribeStates('control.*');

        // connect to OnlyCat API via socket.io and retrieve data
        this.log.debug(`Starting OnlyCat Adapter v${ADAPTER_VERSION}`);
        this.connectToApiAndStartRetrievingData();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback method to be called on unload
     */
    onUnload(callback) {
        try {
            this.adapterUnloaded = true;
            this.unsubscribeEvents();
            this.clearReconnectTimer();
            this.clearEventUpdateTimer();
            this.clearSubscriptions();
            this.api.closeConnection();
            this.setConnectionStatusToAdapter(false);
            this.log.info(`everything cleaned up`);
        } catch (e) {
            this.log.warn(`adapter clean up failed: ${e}`);
        } finally {
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  * @param {string} id
    //  * @param {ioBroker.Object | null | undefined} obj
    //  */
    // onObjectChange(id, obj) {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes.
     *
     * @param {string} id the id of the changed state
     * @param {ioBroker.State | null | undefined} state the new state value
     */
    onStateChange(id, state) {
        if (id && state && state.ack === false) {
            const pathElements = id.split('.');
            const group = pathElements[pathElements.length - 2];
            const control = pathElements[pathElements.length - 1];
            if (group === 'control') {
                if (control === 'disconnect') {
                    this.log.info(`Disconnect Button pressed: ${state.val}`);
                    this.api.disconnectSocket();
                } else if (control === 'reconnect') {
                    this.log.info(`Reconnect Button pressed: ${state.val}`);
                    this.api.disconnectEngine();
                } else if (control === 'getEvents') {
                    this.log.info(`GetEvents Button pressed: ${state.val}`);
                    this.getAndUpdateEvents();
                }
            }
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }

    /*******************************************
     * methods to communicate with OnlyCat API *
     *******************************************/

    /**
     * Starts loading data from the OnlyCat API.
     */
    connectToApiAndStartRetrievingData() {
        this.clearReconnectTimer();
        this.clearEventUpdateTimer();
        this.setConnectionStatusToAdapter(false);
        this.log.info(`Connecting...`);
        this.connectToApi()
            .then(() => this.getDevices())
            .then(() => this.getRfids())
            .then(() => this.getRfidProfiles())
            .then(() => this.getEvents())
            .then(() => this.createAdapterObjectHierarchy())
            .then(() => this.updateDevices())
            .then(() => this.updateEvents())
            .then(() => this.updateLatestEvents())
            .then(() => this.updateAdapterVersion())
            .then(() => this.subscribeEvents())
            .catch(error => {
                if (error === undefined || error.message === undefined || error.message === this.lastError) {
                    this.log.debug(error);
                } else {
                    this.log.error(error);
                    this.lastError = error.message;
                }
                this.setConnectionStatusToAdapter(false);
                this.log.info(`Disconnected.`);
                this.reconnectToApi();
            });
    }

    /**
     * Initializes the connection to OnlyCat API.
     *
     * @returns {Promise<void>}
     */
    connectToApi() {
        return new Promise((resolve, reject) => {
            // set connection state to STARTING
            this.api.prepareConnection();
            const connectingSubscription = this.api.connectionState$.subscribe(connectionState => {
                if (connectionState === this.api.ConnectionState.Disconnected) {
                    connectingSubscription.unsubscribe();
                    this.log.debug(`New initial connection state: '${connectionState}'`);
                    this.api.closeConnection();
                    reject(`Connection to OnlyCat API failed.`);
                }
                if (connectionState === this.api.ConnectionState.Connected) {
                    connectingSubscription.unsubscribe();
                    this.setConnectionStatusToAdapter(true);
                    this.log.info(`Connected.`);
                    this.resetEventUpdateCounter();
                    this.clearConnectionStateSubscription();
                    this.clearUserSubscription();
                    this.connectionStatusSubcription = this.api.connectionState$.subscribe(connectionState =>
                        this.onConnectionStateChange(connectionState),
                    );
                    this.userSubscription = this.api.user$.subscribe(user => this.onUserChange(user));
                    resolve();
                } else {
                    this.log.debug(`New initial connection state: '${connectionState}'`);
                }
            });
            this.api.initConnection();
        });
    }

    /**
     * Reconnects to OnlyCat API after a disconnect.
     */
    reconnectToApi() {
        if (!this.adapterUnloaded) {
            if (this.api.isReconnecting()) {
                this.log.info(`Automatic Reconnecting is active.`);
                //this.log.info(`Setting reconnecting to 'true'.`);
                this.reconnecting = true;
            } else {
                this.clearReconnectTimer();
                this.resetEventUpdateCounter();
                this.clearConnectionStateSubscription();
                this.currentUser = undefined;
                this.api.closeConnection();
                this.log.info(`Reconnecting in ${RETRY_FREQUENCY_CONNECT} seconds.`);
                this.reconnectTimerId = this.setTimeout(
                    this.connectToApiAndStartRetrievingData.bind(this),
                    RETRY_FREQUENCY_CONNECT * 1000,
                );
            }
        }
    }

    /**
     * Subscribe to events.
     *
     * @returns {Promise<void>}
     */
    subscribeEvents() {
        return new Promise(resolve => {
            this.log.debug(`Subscribing to events...`);
            this.api.subscribeToEvent('userEventUpdate', data => this.onEventReceived(data));
            this.log.debug(`Events subscribed.`);
            return resolve();
        });
    }

    /**
     * Unsubscribe from events.
     */
    unsubscribeEvents() {
        this.log.debug(`Unsubscribing from events...`);
        this.api.unsubscribeFromEvent('userEventUpdate');
        this.log.debug(`Events unsubscribed.`);
    }

    /**
     * User change handler.
     *
     * @param {any} user the new user
     */
    onUserChange(user) {
        if (user !== undefined) {
            this.log.debug(`User changed${user.id ? ` for user: ${user.id}` : ''}.`);
            if (this.currentUser !== undefined) {
                this.log.debug(`User changed, getting Events.`);
                this.resetEventUpdateCounter();
                this.getAndUpdateEvents();
            }
            this.currentUser = user;
        }
    }

    /**
     * Connection state change handler.
     *
     * @param {string} connectionState the new connection state
     */
    onConnectionStateChange(connectionState) {
        this.log.debug(`New connection state: '${connectionState}'`);
        if (connectionState === this.api.ConnectionState.Connected) {
            this.clearReconnectTimer();
            if (this.reconnecting) {
                this.reconnecting = false;
            }
        }
        if (connectionState === this.api.ConnectionState.Disconnected) {
            this.log.info(`Disconnected.`);
            this.clearEventUpdateTimer();
            this.reconnectToApi();
        }
    }

    /**
     * Handles received events.
     *
     * @param {any} data the received event data
     */
    onEventReceived(data) {
        this.log.debug(`Received event update.`);
        this.log.silly(`Received event update: ${JSON.stringify(data)}`);
        this.resetEventUpdateCounter();
        this.getAndUpdateEvents();
    }

    /**
     * Handles event update timer.
     */
    onEventUpdateTimer() {
        this.log.debug(`Event update timer triggered.`);
        this.getAndUpdateEvents();
    }

    /**
     * Gets and updates events.
     */
    getAndUpdateEvents() {
        this.getEvents()
            .then(() => this.updateEvents())
            .then(() => this.updateLatestEvents())
            .catch(error => {
                if (error === undefined || error.message === undefined || error.message === this.lastError) {
                    this.log.debug(error);
                } else {
                    this.log.error(error);
                    this.lastError = error.message;
                }
                this.log.warn(`Event update failed.`);
            });
    }

    /**
     * Get devices from OnlyCat API.
     *
     * @returns {Promise<void>}
     */
    getDevices() {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get devices, adapter already unloaded.`);
            } else {
                this.log.debug(`Getting devices...`);
                this.api
                    .request('getDevices', { subscribe: true })
                    .then(response => {
                        this.devices = response;
                        for (let d = 0; d < this.devices.length; d++) {
                            if ('description' in this.devices[d]) {
                                this.devices[d].description_org = this.devices[d].description;
                                this.devices[d].description = this.normalizeString(this.devices[d].description);
                                if (this.devices[d].description_org !== this.devices[d].description) {
                                    this.log.debug(
                                        `Normalizing device name from: '${this.devices[d].description_org}' to '${this.devices[d].description}'`,
                                    );
                                }
                            }
                        }
                        this.log.debug(
                            this.devices.length === 1 ? `Got 1 device.` : `Got ${this.devices.length} devices.`,
                        );
                        this.log.silly(`Getting devices response: '${JSON.stringify(response)}'.`);
                        return resolve();
                    })
                    .catch(error => {
                        reject(error);
                    });
            }
        });
    }

    /**
     * Get RFIDs from OnlyCat API.
     *
     * @returns {Promise<void>}
     */
    getRfids() {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get RFIDs, adapter already unloaded.`);
            } else {
                const promiseArray = [];
                this.rfids = [];
                this.log.debug(`Getting RFIDs...`);
                for (let d = 0; d < this.devices.length; d++) {
                    promiseArray.push(this.getRfidsForDevice(this.devices[d].deviceId));
                }
                Promise.all(promiseArray)
                    .then(() => {
                        this.log.debug(this.rfids.length === 1 ? `Got 1 RFID.` : `Got ${this.rfids.length} RFIDs.`);
                        this.log.silly(`Getting RFIDs response: '${JSON.stringify(this.rfids)}'.`);
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not get RFIDs (${error}).`);
                        return reject();
                    });
            }
        });
    }

    /**
     * Get RFIDs for device from OnlyCat API.
     *
     * @param {string} deviceId a device id
     * @returns {Promise<void>}
     */
    getRfidsForDevice(deviceId) {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get RFIDs for device with id '${deviceId}', adapter already unloaded.`);
            } else {
                this.log.debug(`Getting RFIDs for device with id '${deviceId}'...`);
                this.api
                    .request('getLastSeenRfidCodesByDevice', { deviceId: deviceId })
                    .then(response => {
                        for (let r = 0; r < response.length; r++) {
                            if ('rfidCode' in response[r]) {
                                this.rfids.push(response[r].rfidCode);
                            }
                        }
                        this.log.debug(
                            response.length === 1
                                ? `Got 1 RFID for '${deviceId}'.`
                                : `Got ${response.length} RFIDs for '${deviceId}'.`,
                        );
                        this.log.silly(`Getting RFIDs response: '${JSON.stringify(response)}'.`);
                        return resolve();
                    })
                    .catch(error => {
                        reject(error);
                    });
            }
        });
    }

    /**
     * Get RFID Profiles from OnlyCat API.
     *
     * @returns {Promise<void>}
     */
    getRfidProfiles() {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get RFID profiles, adapter already unloaded.`);
            } else {
                const promiseArray = [];
                this.rfidProfiles = {};
                this.log.debug(`Getting RFID profiles...`);
                for (let r = 0; r < this.rfids.length; r++) {
                    promiseArray.push(this.getRfidProfileForRfid(this.rfids[r]));
                }
                Promise.all(promiseArray)
                    .then(() => {
                        let profileCount = 0;
                        for (let r = 0; r < this.rfids.length; r++) {
                            if (this.rfids[r] in this.rfidProfiles) {
                                profileCount++;
                            }
                        }
                        this.log.debug(
                            profileCount === 1 ? `Got 1 RFID profile.` : `Got ${profileCount} RFID profiles.`,
                        );
                        this.log.silly(`Getting RFID profiles response: '${JSON.stringify(this.rfidProfiles)}'.`);
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not get RFIDs (${error}).`);
                        return reject();
                    });
            }
        });
    }

    /**
     * Get RFID Profile for RFID from OnlyCat API.
     *
     * @param {string} rfid a rfid
     * @returns {Promise<void>}
     */
    getRfidProfileForRfid(rfid) {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get RFID profile for RFID '${rfid}', adapter already unloaded.`);
            } else {
                this.log.debug(`Getting RFID profile for RFID '${rfid}'...`);
                this.api
                    .request('getRfidProfile', { rfidCode: rfid })
                    .then(response => {
                        this.rfidProfiles[rfid] = response;
                        if ('label' in this.rfidProfiles[rfid]) {
                            this.rfidProfiles[rfid].label_org = this.rfidProfiles[rfid].label;
                            this.rfidProfiles[rfid].label = this.normalizeString(this.rfidProfiles[rfid].label);
                            if (this.rfidProfiles[rfid].label_org !== this.rfidProfiles[rfid].label) {
                                this.log.debug(
                                    `Normalizing pet name from: '${this.rfidProfiles[rfid].label_org}' to '${this.rfidProfiles[rfid].label}'`,
                                );
                            }
                        }
                        this.log.debug(`Got RFID profile for RFID '${rfid}'.`);
                        this.log.silly(`Getting RFID profile response: '${JSON.stringify(response)}'.`);
                        return resolve();
                    })
                    .catch(error => {
                        reject(error);
                    });
            }
        });
    }

    /**
     * Get events from OnlyCat API.
     *
     * @returns {Promise<void>}
     */
    getEvents() {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get events, adapter already unloaded.`);
            } else {
                this.log.debug(`Getting events...`);
                this.api
                    .request('getEvents', { subscribe: true })
                    .then(response => {
                        this.lastEvents = this.events;
                        this.events = response;
                        this.log.debug(
                            this.events.length <= 1
                                ? `Got ${this.events.length} event.`
                                : `Got ${this.events.length} events.`,
                        );
                        return resolve();
                    })
                    .catch(error => {
                        reject(error);
                    });
            }
        });
    }

    /**
     * Checks whether the last received event is final, i.e. has a frameCount
     * and schedules an event update if not.
     */
    checkTriggerEventUpdate() {
        if (this.devices && this.events && this.events.length > 0) {
            this.log.debug(`Checking if last event is final...`);
            if (!this.isEventFinal(this.events[0])) {
                if (this.eventUpdateCounter < MAX_EVENT_UPDATE) {
                    this.clearEventUpdateTimer();
                    this.eventUpdateCounter++;
                    const updateTimeout = Math.max(
                        MINIMUM_EVENT_UPDATE_FREQUENCY,
                        this.fibonacci(this.eventUpdateCounter),
                    );
                    this.log.debug(
                        `Last event not yet final, trigger ${this.eventUpdateCounter}. update in ${updateTimeout} seconds.`,
                    );
                    this.eventUpdateTimerId = this.setTimeout(this.onEventUpdateTimer.bind(this), updateTimeout * 1000);
                } else {
                    this.log.debug(
                        `Last event not yet final, but max event update counter reached: ${this.eventUpdateCounter}.`,
                    );
                }
            } else {
                this.log.debug(`Last event is final.`);
                this.resetEventUpdateCounter();
            }
        }
    }

    /************************************************
     * methods to initially create object hierarchy *
     ************************************************/

    /**
     * Creates the adapters object hierarchy.
     *
     * @returns {Promise<void>}
     */
    createAdapterObjectHierarchy() {
        return new Promise((resolve, reject) => {
            this.log.debug(`Creating object hierarchy...`);
            this.createDevicesToAdapter()
                .then(() => this.createEventsToAdapter())
                .then(() => this.createPetsToAdapter())
                .then(() => {
                    this.log.debug(`Object hierarchy created.`);
                    return resolve();
                })
                .catch(() => {
                    this.log.error(`Creating object hierarchy failed.`);
                    return reject();
                });
        });
    }

    /**
     * Creates device hierarchy data structures in the adapter.
     *
     * @returns {Promise<void>}
     */
    createDevicesToAdapter() {
        return new Promise((resolve, reject) => {
            const promiseArray = [];

            // create devices
            for (let d = 0; d < this.devices.length; d++) {
                const objName = this.devices[d].description;

                this.setObjectNotExists(
                    objName,
                    this.buildDeviceObject(`Device '${this.devices[d].description_org}' (${this.devices[d].deviceId})`),
                    () => {
                        promiseArray.push(
                            this.setObjectNotExistsAsync(
                                `${objName}.deviceId`,
                                this.buildStateObject('id of the device', 'text', 'string'),
                            ),
                        );
                        promiseArray.push(
                            this.setObjectNotExistsAsync(
                                `${objName}.description`,
                                this.buildStateObject('description of the device', 'text', 'string'),
                            ),
                        );
                        promiseArray.push(
                            this.setObjectNotExistsAsync(
                                `${objName}.timeZone`,
                                this.buildStateObject('timeZone of the device', 'text', 'string'),
                            ),
                        );
                        promiseArray.push(
                            this.setObjectNotExistsAsync(
                                `${objName}.deviceTransitPolicyId`,
                                this.buildStateObject('deviceTransitPolicyId of the device', 'text', 'number'),
                            ),
                        );
                        promiseArray.push(
                            this.setObjectNotExistsAsync(
                                `${objName}.cursorId`,
                                this.buildStateObject('cursorId of the device', 'text', 'number'),
                            ),
                        );
                    },
                );
            }

            Promise.all(promiseArray)
                .then(() => {
                    return resolve();
                })
                .catch(error => {
                    this.log.warn(`Could not create adapter device hierarchy (${error}).`);
                    return reject();
                });
        });
    }

    /**
     * Creates event hierarchy data structures in the adapter.
     *
     * @returns {Promise<void>}
     */
    createEventsToAdapter() {
        return new Promise((resolve, reject) => {
            const promiseArray = [];
            for (let d = 0; d < this.devices.length; d++) {
                const objName = this.devices[d].description;
                promiseArray.push(this.createEventsAsJsonToAdapter(objName));
                promiseArray.push(this.createEventsAsStateObjectsToAdapter(objName));
            }
            Promise.all(promiseArray)
                .then(() => {
                    return resolve();
                })
                .catch(error => {
                    this.log.warn(`Could not create adapter events hierarchy (${error}).`);
                    return reject();
                });
        });
    }

    /**
     * Creates pet hierarchy data structures in the adapter.
     *
     * @returns {Promise<void>}
     */
    createPetsToAdapter() {
        return new Promise((resolve, reject) => {
            const promiseArray = [];
            for (let d = 0; d < this.devices.length; d++) {
                const objName = this.devices[d].description;
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.pets`,
                        this.buildChannelObject('status und latest events for pets'),
                    ),
                );
            }
            Promise.all(promiseArray)
                .then(() => {
                    return resolve();
                })
                .catch(error => {
                    this.log.warn(`Could not create adapter pets hierarchy (${error}).`);
                    return reject();
                });
        });
    }

    /**
     * Creates events as json.
     *
     * @param {string} objName the object name to create events for
     * @returns {Promise<void>}
     */
    createEventsAsJsonToAdapter(objName) {
        return new Promise((resolve, reject) => {
            const promiseArray = [];
            this.setObjectNotExists(`${objName}.jsonEvents`, this.buildChannelObject('events in json format'), () => {
                for (let e = 0; e < 10; e++) {
                    promiseArray.push(
                        this.setObjectNotExistsAsync(
                            `${objName}.jsonEvents.${this.padZero(e + 1)}`,
                            this.buildStateObject(`event ${e + 1}`, 'json', 'string'),
                        ),
                    );
                }
                Promise.all(promiseArray)
                    .then(() => {
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not create adapter events json hierarchy (${error}).`);
                        return reject();
                    });
            });
        });
    }

    /**
     * Creates events as state objects.
     *
     * @param {string} objName the object name to create events for
     * @returns {Promise<void>}
     */
    createEventsAsStateObjectsToAdapter(objName) {
        return new Promise((resolve, reject) => {
            const promiseArray = [];
            this.setObjectNotExists(`${objName}.events`, this.buildChannelObject('events as state objects'), () => {
                for (let e = 0; e < 10; e++) {
                    promiseArray.push(
                        this.createEventStateObjectsToAdapter(
                            `${objName}.events.${this.padZero(e + 1)}`,
                            `event ${e + 1}`,
                        ),
                    );
                }
                Promise.all(promiseArray)
                    .then(() => {
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not create adapter events objects hierarchy (${error}).`);
                        return reject();
                    });
            });
        });
    }

    /**
     * Creates an event as state objects.
     *
     * @param {string} objName the object name to create an event state for
     * @param {string} description a description for the event state
     * @returns {Promise<void>}
     */
    createEventStateObjectsToAdapter(objName, description) {
        return new Promise((resolve, reject) => {
            const promiseArray = [];
            this.setObjectNotExists(objName, this.buildFolderObject(description), () => {
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.accessToken`,
                        this.buildStateObject('Access token', 'text', 'string'),
                    ),
                );
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.deviceId`,
                        this.buildStateObject('Device ID', 'text', 'string'),
                    ),
                );
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.eventClassification`,
                        this.buildStateObject('Event classification', 'text', 'number', true, EVENT_CLASSIFICATION),
                    ),
                );
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.eventId`,
                        this.buildStateObject('Event ID', 'text', 'number'),
                    ),
                );
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.eventTriggerSource`,
                        this.buildStateObject('Event trigger source', 'text', 'number', true, EVENT_TRIGGER_SOURCE),
                    ),
                );
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.frameCount`,
                        this.buildStateObject('Frame count', 'text', 'number'),
                    ),
                );
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.globalId`,
                        this.buildStateObject('Global ID', 'text', 'number'),
                    ),
                );
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.posterFrameIndex`,
                        this.buildStateObject('Poster frame index', 'text', 'number'),
                    ),
                );
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.rfidCodes`,
                        this.buildStateObject('RFID codes', 'list', 'array'),
                    ),
                );
                promiseArray.push(
                    this.setObjectNotExistsAsync(
                        `${objName}.timestamp`,
                        this.buildStateObject('Timestamp', 'date', 'string'),
                    ),
                );

                Promise.all(promiseArray)
                    .then(() => {
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not create adapter event objects (${error}).`);
                        return reject();
                    });
            });
        });
    }
    /*
	this.events = [
					  {
						  "globalId": 2238848,
						  "deviceId": "OC-8C1F64481431",
						  "eventId": 69,
						  "timestamp": "2025-04-06T14:44:20.000Z",
						  "frameCount": 133,
						  "eventTriggerSource": 3,
						  "eventClassification": 1,
						  "posterFrameIndex": 4,
						  "accessToken": "W5XlH_",
						  "rfidCodes": [
							  "276095611215361"
						  ]
					  }
				  ];
	 */

    /****************************************
     * methods to set values to the adapter *
     ****************************************/

    /**
     * Update devices with the received data.
     *
     * @returns {Promise<void>}
     */
    updateDevices() {
        return new Promise((resolve, reject) => {
            if (this.devices) {
                for (let d = 0; d < this.devices.length; d++) {
                    const objName = this.devices[d].description;
                    this.setState(`${objName}.deviceId`, this.devices[d].deviceId, true);
                    this.setState(`${objName}.description`, this.devices[d].description, true);
                    this.setState(`${objName}.timeZone`, this.devices[d].timeZone, true);
                    this.setState(`${objName}.deviceTransitPolicyId`, this.devices[d].deviceTransitPolicyId, true);
                    this.setState(`${objName}.cursorId`, this.devices[d].cursorId, true);
                }
                return resolve();
            }
            return reject(new Error(`no device data found.`));
        });
    }

    /**
     * Update events with the received data.
     *
     * @returns {Promise<void>}
     */
    updateEvents() {
        return new Promise((resolve, reject) => {
            this.log.debug(`Updating events...`);
            if (this.devices) {
                if (this.events) {
                    if (!this.lastEvents || JSON.stringify(this.events) !== JSON.stringify(this.lastEvents)) {
                        for (let d = 0; d < this.devices.length; d++) {
                            let eventNumber = 1;
                            const objName = this.devices[d].description;
                            for (let e = 0; e < this.events.length; e++) {
                                if (this.events[e].deviceId === this.devices[d].deviceId) {
                                    if (eventNumber <= 10) {
                                        this.setEventJsonToAdapter(
                                            `${objName}.jsonEvents.${this.padZero(eventNumber)}`,
                                            e,
                                        );
                                        this.setEventStatesToAdapter(
                                            `${objName}.events.${this.padZero(eventNumber)}`,
                                            e,
                                        );
                                        eventNumber++;
                                    }
                                }
                            }
                        }
                        this.log.debug(`Events updated.`);
                        this.setLastUpdateToAdapter();
                    } else {
                        this.log.debug(`No change in events, nothing to update.`);
                    }
                    this.checkTriggerEventUpdate();
                    return resolve();
                }
                return reject(new Error(`no event data found.`));
            }
            return reject(new Error(`no device data found.`));
        });
    }

    /**
     * Sets the event at the given index as json to the given object.
     *
     * @param {string} objName the object to set the json to
     * @param {number} eventIndex the event index
     */
    setEventJsonToAdapter(objName, eventIndex) {
        this.setState(objName, JSON.stringify(this.events[eventIndex]), true);
    }

    /**
     * Sets the event at the given index as states to the given object.
     *
     * @param {string} objName the object to set the states to
     * @param {number} eventIndex the event index
     */
    setEventStatesToAdapter(objName, eventIndex) {
        this.setState(`${objName}.accessToken`, this.events[eventIndex].accessToken, true);
        this.setState(`${objName}.deviceId`, this.events[eventIndex].deviceId, true);
        this.setState(`${objName}.eventClassification`, this.events[eventIndex].eventClassification, true);
        this.setState(`${objName}.eventId`, this.events[eventIndex].eventId, true);
        this.setState(`${objName}.eventTriggerSource`, this.events[eventIndex].eventTriggerSource, true);
        this.setState(`${objName}.frameCount`, this.events[eventIndex].frameCount, true);
        this.setState(`${objName}.globalId`, this.events[eventIndex].globalId, true);
        this.setState(`${objName}.posterFrameIndex`, this.events[eventIndex].posterFrameIndex, true);
        this.setState(`${objName}.rfidCodes`, JSON.stringify(this.events[eventIndex].rfidCodes), true);
        this.setState(`${objName}.timestamp`, this.events[eventIndex].timestamp, true);
    }

    /**
     * Creates and sets the latest events for a given pet rfid to the adapter.
     *
     * @param {string} objName the object name to create the events for
     * @param {any} latestEvents the latest events
     * @param {string} rfidCode the rfid
     * @param {string} petName the pet name
     * @returns {Promise<void>}
     */
    setLatestEventsForRfidToAdapter(objName, latestEvents, rfidCode, petName) {
        return new Promise((resolve, reject) => {
            this.setObjectNotExists(
                objName,
                this.buildFolderObject(
                    `status and latest events for ${petName ? `'${petName}'` : `pet with rfid '${rfidCode}'`}`,
                ),
                () => {
                    const promiseArray = [];
                    for (let t = 0; t <= EVENT_TYPE_MAX; t++) {
                        if (t in latestEvents) {
                            promiseArray.push(
                                this.setLatestEventForRfidAndEventTypeToAdapter(
                                    `${objName}.${EVENT_TYPE_NAME[t]}`,
                                    EVENT_TYPE_NAME[t],
                                    latestEvents[t].eventIndex,
                                    rfidCode,
                                    petName,
                                ),
                            );
                        }
                    }
                    this.setObjectNotExists(
                        `${objName}.status`,
                        this.buildStateObject(
                            `status for ${petName ? `'${petName}'` : `pet with rfid '${rfidCode}'`}`,
                            'indicator',
                            'string',
                        ),
                        () => {
                            if ('inside' in latestEvents && latestEvents.inside !== undefined) {
                                promiseArray.push(
                                    this.setState(
                                        `${objName}.status`,
                                        latestEvents.inside ? 'inside' : 'outside',
                                        true,
                                    ),
                                );
                            }
                            Promise.all(promiseArray)
                                .then(() => {
                                    return resolve();
                                })
                                .catch(error => {
                                    this.log.warn(`Could not set latest events for pet rfid (${error}).`);
                                    return reject();
                                });
                        },
                    );
                },
            );
        });
    }

    /**
     * Creates the state objects and sets the state values for the latest event of a given event type for a given rfid.
     *
     * @param {string} objName the object name to create state objects for
     * @param {string} eventType the event type
     * @param {number} eventIndex the event index
     * @param {string} rfidCode the rfid
     * @param {string} petName the pet name
     * @returns {Promise<void>}
     */
    setLatestEventForRfidAndEventTypeToAdapter(objName, eventType, eventIndex, rfidCode, petName) {
        return new Promise((resolve, reject) => {
            this.createEventStateObjectsToAdapter(
                objName,
                `latest '${eventType}' event for ${petName ? `'${petName}'` : `pet with rfid '${rfidCode}'`}`,
            )
                .then(() => {
                    this.setEventStatesToAdapter(objName, eventIndex);
                    this.setObjectNotExists(
                        `${objName}.json`,
                        this.buildStateObject('event json', 'json', 'string'),
                        () => {
                            this.setEventJsonToAdapter(`${objName}.json`, eventIndex);
                            return resolve();
                        },
                    );
                })
                .catch(error => {
                    this.log.warn(
                        `Could not create latest event for rfid '${rfidCode}' event type '${eventType}' (${error}).`,
                    );
                    return reject();
                });
        });
    }

    /**
     * Updates the latest events per rfid and event type.
     *
     * @returns {Promise<void>}
     */
    updateLatestEvents() {
        return new Promise((resolve, reject) => {
            if (this.devices) {
                if (this.events) {
                    this.log.debug(`Updating latest events...`);
                    const promiseArray = [];
                    const latestEvents = this.calculateLatestEvents();
                    for (let d = 0; d < this.devices.length; d++) {
                        if (d in latestEvents) {
                            for (let r = 0; r < latestEvents[d].rfidCodes.length; r++) {
                                const rfidCode = latestEvents[d].rfidCodes[r];
                                let petName = undefined;
                                if (rfidCode in this.rfidProfiles && 'label' in this.rfidProfiles[rfidCode]) {
                                    petName = this.rfidProfiles[rfidCode].label;
                                }
                                promiseArray.push(
                                    this.setLatestEventsForRfidToAdapter(
                                        `${this.devices[d].description}.pets.${petName ? petName : rfidCode}`,
                                        latestEvents[d][rfidCode],
                                        rfidCode,
                                        petName,
                                    ),
                                );
                            }
                        }
                    }
                    Promise.all(promiseArray)
                        .then(() => {
                            this.log.debug(`Latest events updated.`);
                            return resolve();
                        })
                        .catch(error => {
                            this.log.warn(`Could not update latest events (${error}).`);
                            return reject();
                        });
                } else {
                    return reject(new Error(`no event data found.`));
                }
            } else {
                return reject(new Error(`no device data found.`));
            }
        });
    }

    /**
     * Calculates the latest events per pet rfid.
     *
     * @returns {any} an object with latest events per pet rfid
     */
    calculateLatestEvents() {
        const latestEvents = {};
        this.log.debug(`Calculating status and latest events...`);
        for (let d = 0; d < this.devices.length; d++) {
            for (let e = 0; e < this.events.length; e++) {
                // ignore entry events who have not yet classified as clear or contraband
                if (!this.isEntryEventWithUnknownClassification(this.events[e])) {
                    if (this.events[e].deviceId === this.devices[d].deviceId) {
                        if (!(d in latestEvents)) {
                            latestEvents[d] = {};
                            latestEvents[d].rfidCodes = [];
                        }
                        for (let r = 0; r < this.events[e].rfidCodes.length; r++) {
                            const rfidCode = this.events[e].rfidCodes[r];
                            if (!latestEvents[d].rfidCodes.includes(rfidCode)) {
                                latestEvents[d].rfidCodes.push(rfidCode);
                                latestEvents[d][rfidCode] = {};
                            }
                            const eventType = this.generateEventType(
                                this.events[e].eventTriggerSource,
                                this.events[e].eventClassification,
                            );
                            if (!(eventType in latestEvents[d][rfidCode])) {
                                latestEvents[d][rfidCode][eventType] = this.events[e];
                                latestEvents[d][rfidCode][eventType].eventIndex = e;
                            } else {
                                if (
                                    new Date(latestEvents[d][rfidCode][eventType].timestamp) <
                                    new Date(this.events[e].timestamp)
                                ) {
                                    latestEvents[d][rfidCode][eventType] = this.events[e];
                                    latestEvents[d][rfidCode][eventType].eventIndex = e;
                                }
                            }
                        }
                    }
                }
            }
            for (let r = 0; r < latestEvents[d].rfidCodes.length; r++) {
                const rfidCode = latestEvents[d].rfidCodes[r];
                if (EVENT_TYPE.EXIT in latestEvents[d][rfidCode] && EVENT_TYPE.ENTRY in latestEvents[d][rfidCode]) {
                    latestEvents[d][rfidCode].inside =
                        new Date(latestEvents[d][rfidCode][EVENT_TYPE.EXIT].timestamp) <
                        new Date(latestEvents[d][rfidCode][EVENT_TYPE.ENTRY].timestamp);
                } else if (EVENT_TYPE.EXIT in latestEvents[d][rfidCode]) {
                    latestEvents[d][rfidCode].inside = false;
                } else if (EVENT_TYPE.ENTRY in latestEvents[d][rfidCode]) {
                    latestEvents[d][rfidCode].inside = true;
                } else {
                    latestEvents[d][rfidCode].inside = undefined;
                }
            }
        }
        this.log.debug(`Status and latest events calculated.`);
        this.log.silly(`Status and latest events: '${JSON.stringify(latestEvents)}'.`);
        return latestEvents;
    }

    /**
     * Updates the adapter version state.
     *
     * @returns {Promise<void>}
     */
    updateAdapterVersion() {
        return new Promise((resolve, reject) => {
            if (!this.adapterUnloaded) {
                this.setAdapterVersionToAdapter(ADAPTER_VERSION);
                return resolve();
            }
            return reject(new Error(`Cannot set adapter version. Adapter already unloaded.`));
        });
    }

    /**
     * Sets the adapter version to the adapter.
     *
     * @param {string} version the version to set
     */
    setAdapterVersionToAdapter(version) {
        this.log.debug(`setting adapter version to adapter`);

        /* objects created via io-package.json, no need to create them here */
        this.setState('info.version', version, true);
    }

    /**
     * Sets connection status to the adapter.
     *
     * @param {boolean} connected whether the adepter is connected
     */
    setConnectionStatusToAdapter(connected) {
        this.log.debug(`setting connection status to adapter`);

        /* objects created via io-package.json, no need to create them here	*/
        this.setState('info.connection', connected, true);
    }

    /**
     * Sets the last time data was received from OnlyCat API.
     */
    setLastUpdateToAdapter() {
        this.log.debug(`setting last update to adapter`);

        /* object created via io-package.json, no need to create them here */
        this.setState('info.lastUpdate', new Date().toISOString(), true);
    }

    /******************
     * helper methods *
     ******************/

    /**
     * Generates the event type from trigger and classification.
     *
     * @param {number} eventTriggerSource a event trigger source
     * @param {number} eventClassification a event classification
     * @returns {number} the event type
     */
    generateEventType(eventTriggerSource, eventClassification) {
        if (
            EVENT_CLASSIFICATION[eventClassification] === 'CONTRABAND' ||
            EVENT_CLASSIFICATION[eventClassification] === 'SUSPICIOUS'
        ) {
            return 4;
        }
        return eventTriggerSource;
    }

    /**
     * Returns the n-th fibonacci number.
     *
     * @param {number} n the number of the fibonacci number to return
     * @returns {number} a fibonacci number
     */
    fibonacci(n) {
        let n1 = 0,
            n2 = 1,
            next = 1;
        for (let i = 1; i < n; i++) {
            next = n1 + n2;
            n1 = n2;
            n2 = next;
        }
        return next;
    }

    /**
     * Returns whether the given event is final, i.e. has a defined frame count.
     *
     * @param {object} event a event
     * @returns {boolean} whether the event is final
     */
    isEventFinal(event) {
        return (
            event !== undefined && 'frameCount' in event && event.frameCount !== undefined && event.frameCount !== null
        );
    }

    /**
     * Returns whether the given event is an entry event with unknown classification.
     *
     * @param {object} event a event
     * @returns {boolean} whether the event is an entry event with unknown classification
     */
    isEntryEventWithUnknownClassification(event) {
        return (
            event !== undefined &&
            'eventTriggerSource' in event &&
            'eventClassification' in event &&
            EVENT_TRIGGER_SOURCE[event.eventTriggerSource] === 'OUTDOOR_MOTION' &&
            EVENT_CLASSIFICATION[event.eventClassification] === 'UNKNOWN'
        );
    }

    /**
     * Resets the event update counter.
     */
    resetEventUpdateCounter() {
        if (this.eventUpdateCounter > 0) {
            this.log.debug(`Reset event update counter to 0 (was ${this.eventUpdateCounter}).`);
            this.eventUpdateCounter = 0;
        }
    }

    /**
     * Clears the reconnect timer
     */
    clearReconnectTimer() {
        if (this.reconnectTimerId !== undefined) {
            this.clearTimeout(this.reconnectTimerId);
            this.reconnectTimerId = undefined;
        }
    }

    /**
     * Clears the event update timer
     */
    clearEventUpdateTimer() {
        if (this.eventUpdateTimerId !== undefined) {
            this.clearTimeout(this.eventUpdateTimerId);
            this.eventUpdateTimerId = undefined;
        }
    }

    /**
     * Clears the connection state and user subscription
     */
    clearSubscriptions() {
        this.clearConnectionStateSubscription();
        this.clearUserSubscription();
    }

    /**
     * Clears the connection state subscription
     */
    clearConnectionStateSubscription() {
        if (this.connectionStatusSubcription !== undefined) {
            this.connectionStatusSubcription.unsubscribe();
            this.connectionStatusSubcription = undefined;
        }
    }

    /**
     * Clears the user subscription
     */
    clearUserSubscription() {
        if (this.userSubscription !== undefined) {
            this.userSubscription.unsubscribe();
            this.userSubscription = undefined;
        }
    }

    /**
     * Checks and logs the values of the adapter configuration
     */
    checkAdapterConfig() {
        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        let configOk = true;
        this.log.debug(`checking adapter configuration...`);
        if (!this.config.token || typeof this.config.token !== 'string' || this.config.token.length === 0) {
            this.log.warn(`Token is invalid. Adapter probably won't work.`);
            configOk = false;
        }
        if (configOk) {
            this.log.info('adapter configuration ok');
        } else {
            this.log.warn('adapter configuration contains errors');
        }
    }

    /**
     * Builds a state object.
     *
     * @param {string} name the state object name
     * @param {string} role the state object role
     * @param {string} type the state object type
     * @param {boolean} readonly whether the state is read only
     * @param {object} states possible state values
     * @returns {object} the state object
     */
    buildStateObject(name, role = 'indicator', type = 'boolean', readonly = true, states = undefined) {
        return states === undefined
            ? {
                  type: 'state',
                  common: {
                      name: name,
                      role: role,
                      type: type,
                      read: true,
                      write: !readonly,
                  },
                  native: {},
              }
            : {
                  type: 'state',
                  common: {
                      name: name,
                      role: role,
                      type: type,
                      read: true,
                      write: !readonly,
                      states: states,
                  },
                  native: {},
              };
    }

    /**
     * Builds a device object.
     *
     * @param {string} name the device object name
     * @returns {object} a device object
     */
    buildDeviceObject(name) {
        return {
            type: 'device',
            common: {
                name: name,
                role: '',
            },
            native: {},
        };
    }

    /**
     * Builds a channel object.
     *
     * @param {string} name the channel object name
     * @returns {object} the channel object
     */
    buildChannelObject(name) {
        return {
            type: 'channel',
            common: {
                name: name,
                role: '',
            },
            native: {},
        };
    }

    /**
     * Builds a folder object.
     *
     * @param {string} name the folder object name
     * @returns {object} a folder object
     */
    buildFolderObject(name) {
        return {
            type: 'folder',
            common: {
                name: name,
                role: '',
            },
            native: {},
        };
    }

    /**
     * Adds a leading 0 to a number if it is smaller than 10.
     *
     * @param {number} num a number
     * @returns {string} a number with a leading 0 if smaller than 10
     */
    padZero(num) {
        const norm = Math.floor(Math.abs(num));
        return (norm < 10 ? '0' : '') + norm;
    }

    /**
     * Removes whitespaces and special characters from input.
     *
     * @param {string} input a input string
     * @returns {string} a string without white spaces and special characters
     */
    normalizeString(input) {
        const reg = /\W/gi;
        const rep = '_';
        return input.replace(reg, rep);
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] adapter options
     */
    module.exports = options => new Template(options);
} else {
    // otherwise start the instance directly
    new Template();
}
