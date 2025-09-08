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
const ADAPTER_VERSION = '0.5.0';
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
        // list of transit policy IDs
        this.transitPolicyIds = [];
        // list of transit policies
        this.transitPolicies = [];
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
        this.subscribeStates('*.control.*');

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
                } else if (control === 'deviceTransitPolicyId' && pathElements.length > 2) {
                    const deviceName = pathElements[pathElements.length - 3];
                    const deviceIndex = this.getDeviceIndexForDeviceDescription(deviceName);
                    if (deviceIndex !== undefined) {
                        if (typeof state.val === 'number') {
                            this.setTransitPolicyForDevice(this.devices[deviceIndex].deviceId, state.val).catch(
                                error => {
                                    this.log.error(error);
                                    this.resetTransitPolicyForDevice(deviceIndex);
                                },
                            );
                        }
                    }
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
            .then(() => this.getDevicesDetails())
            .then(() => this.getRfids())
            .then(() => this.getRfidProfiles())
            .then(() => this.getEvents())
            .then(() => this.getTransitPolicyIds())
            .then(() => this.getTransitPolicies())
            .then(() => this.createAdapterObjectHierarchy())
            .then(() => this.updateDevices())
            .then(() => this.updateEvents())
            .then(() => this.updateLatestEvents())
            .then(() => this.updateTransitPolicies())
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
            this.api.subscribeToEvent('userEventUpdate', data => this.onEventUpdateReceived(data));
            this.api.subscribeToEvent('deviceUpdate', data => this.onDeviceUpdateReceived(data));
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
        this.api.unsubscribeFromEvent('deviceUpdate');
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
                this.getAndUpdateDevicesAndTransitPolicies();
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
     * Handles received event updates.
     *
     * @param {any} data the received event data
     */
    onEventUpdateReceived(data) {
        this.log.debug(`Received event update.`);
        this.log.silly(`Received event update: ${JSON.stringify(data)}`);
        this.resetEventUpdateCounter();
        this.getAndUpdateEvents();
    }

    /**
     * Handles received device updates.
     *
     * @param {any} data the received device data
     */
    onDeviceUpdateReceived(data) {
        this.log.debug(`Received device update.`);
        this.log.silly(`Received device update: ${JSON.stringify(data)}`);
        let deviceIds = [];
        if (Array.isArray(data)) {
            for (let d = 0; d < data.length; d++) {
                if ('deviceId' in data[d]) {
                    deviceIds.push(data[d].deviceId);
                }
            }
        }
        this.getAndUpdateDevicesAndTransitPoliciesForDeviceIds(
            deviceIds.length !== 0 ? deviceIds : this.getAllDeviceIds(),
        );
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
     * Gets and updates all devices and transit policies.
     */
    getAndUpdateDevicesAndTransitPolicies() {
        this.getAndUpdateDevicesAndTransitPoliciesForDeviceIds(this.getAllDeviceIds());
    }

    /**
     * Gets and updates the given devices and their transit policies.
     *
     * @param {Array} deviceIds an array of device IDs
     */
    getAndUpdateDevicesAndTransitPoliciesForDeviceIds(deviceIds) {
        this.getDevices()
            .then(() => this.getDevicesDetailsForDeviceIds(deviceIds))
            .then(() => this.getTransitPolicies())
            .then(() => this.updateDevicesForDeviceIds(deviceIds))
            .then(() => this.updateTransitPoliciesForDeviceIds(deviceIds))
            .catch(error => {
                this.log.error(error);
                this.log.warn(`Device and transit policy update failed.`);
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
     * Get devices details from OnlyCat API.
     *
     * @returns {Promise<void>}
     */
    getDevicesDetails() {
        return this.getDevicesDetailsForDeviceIds(this.getAllDeviceIds());
    }

    /**
     * Get devices details for the given device IDs from OnlyCat API.
     *
     * @param {Array} deviceIds an array of device IDs
     * @returns {Promise<void>}
     */
    getDevicesDetailsForDeviceIds(deviceIds) {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get devices details, adapter already unloaded.`);
            } else {
                const promiseArray = [];
                this.log.debug(`Getting devices details...`);
                for (let d = 0; d < this.devices.length; d++) {
                    if (deviceIds.includes(this.devices[d].deviceId)) {
                        promiseArray.push(this.getDeviceDetailsForDevice(d));
                    }
                }
                Promise.all(promiseArray)
                    .then(() => {
                        this.log.debug(
                            this.devices.length === 1
                                ? `Got 1 device details.`
                                : `Got ${deviceIds.length} device details.`,
                        );
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not get device details (${error}).`);
                        return reject();
                    });
            }
        });
    }

    /**
     * Get device details for a device from OnlyCat API.
     *
     * @param {number} deviceIndex a device index within this.devices
     * @returns {Promise<void>}
     */
    getDeviceDetailsForDevice(deviceIndex) {
        return new Promise((resolve, reject) => {
            const deviceId = this.devices[deviceIndex].deviceId;
            if (this.adapterUnloaded) {
                reject(`Can not get device details for device ID '${deviceId}', adapter already unloaded.`);
            } else {
                this.log.debug(`Getting device details for device ID '${deviceId}'...`);
                this.api
                    .request('getDevice', { deviceId: deviceId, subscribe: true })
                    .then(response => {
                        if ('firmwareChannel' in response) {
                            this.devices[deviceIndex].firmwareChannel = response.firmwareChannel;
                        }
                        if ('connectivity' in response) {
                            this.devices[deviceIndex].connectivity = response.connectivity;
                        }
                        this.log.silly(
                            `Getting device details for device ID '${deviceId}' response: '${JSON.stringify(response)}'.`,
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
     * Get Transit Policy IDs from OnlyCat API.
     *
     * @returns {Promise<void>}
     */
    getTransitPolicyIds() {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get transit policy IDs, adapter already unloaded.`);
            } else {
                const promiseArray = [];
                this.transitPolicyIds = [];
                this.log.debug(`Getting transit policy IDs...`);
                for (let d = 0; d < this.devices.length; d++) {
                    promiseArray.push(this.getTransitPolicyIDsForDevice(this.devices[d].deviceId));
                }
                Promise.all(promiseArray)
                    .then(() => {
                        this.log.debug(
                            this.transitPolicyIds.length === 1
                                ? `Got 1 transit policy ID.`
                                : `Got ${this.transitPolicyIds.length} transit policy IDs.`,
                        );
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not get transit policy IDs (${error}).`);
                        return reject();
                    });
            }
        });
    }

    /**
     * Get Transit Policy IDs from OnlyCat API.
     *
     * @param {string} deviceId a device id
     * @returns {Promise<void>}
     */
    getTransitPolicyIDsForDevice(deviceId) {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get transit policy IDs, adapter already unloaded.`);
            } else {
                this.log.debug(`Getting transit policy IDs for device '${deviceId}'...`);
                this.api
                    .request('getDeviceTransitPolicies', { deviceId: deviceId })
                    .then(response => {
                        for (let p = 0; p < response.length; p++) {
                            if ('deviceTransitPolicyId' in response[p]) {
                                this.transitPolicyIds.push(response[p].deviceTransitPolicyId);
                            }
                        }
                        this.log.debug(
                            response.length === 1
                                ? `Got 1 transit policy ID for '${deviceId}'.`
                                : `Got ${response.length} transit policy IDs for '${deviceId}'.`,
                        );
                        this.log.silly(`Getting transit policy IDs response: '${JSON.stringify(response)}'.`);
                        return resolve();
                    })
                    .catch(error => {
                        reject(error);
                    });
            }
        });
    }

    /**
     * Get Transit Policies from OnlyCat API.
     *
     * @returns {Promise<void>}
     */
    getTransitPolicies() {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get transit policies, adapter already unloaded.`);
            } else {
                const promiseArray = [];
                this.transitPolicies = [];
                this.log.debug(`Getting transit policies...`);
                for (let i = 0; i < this.transitPolicyIds.length; i++) {
                    promiseArray.push(this.getTransitPolicyForPolicyID(this.transitPolicyIds[i]));
                }
                Promise.all(promiseArray)
                    .then(() => {
                        this.log.debug(
                            this.transitPolicyIds.length === 1
                                ? `Got 1 transit policy ID.`
                                : `Got ${this.transitPolicyIds.length} transit policy IDs.`,
                        );
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not get transit policy IDs (${error}).`);
                        return reject();
                    });
            }
        });
    }

    /**
     * Get Transit Policy from OnlyCat API.
     *
     * @param {number} deviceTransitPolicyId a transit policy ID
     * @returns {Promise<void>}
     */
    getTransitPolicyForPolicyID(deviceTransitPolicyId) {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not get transit policy, adapter already unloaded.`);
            } else {
                this.log.debug(`Getting transit policy for transit policy ID '${deviceTransitPolicyId}'...`);
                this.api
                    .request('getDeviceTransitPolicy', { deviceTransitPolicyId: deviceTransitPolicyId })
                    .then(response => {
                        this.transitPolicies[deviceTransitPolicyId] = response;
                        if ('name' in this.transitPolicies[deviceTransitPolicyId]) {
                            this.transitPolicies[deviceTransitPolicyId].name_org =
                                this.transitPolicies[deviceTransitPolicyId].name;
                            this.transitPolicies[deviceTransitPolicyId].name = this.normalizeString(
                                this.transitPolicies[deviceTransitPolicyId].name,
                            );
                            if (
                                this.transitPolicies[deviceTransitPolicyId].name_org !==
                                this.transitPolicies[deviceTransitPolicyId].name
                            ) {
                                this.log.debug(
                                    `Normalizing transit policy name from: '${this.transitPolicies[deviceTransitPolicyId].name_org}' to '${this.transitPolicies[deviceTransitPolicyId].name}'`,
                                );
                            }
                        }
                        this.log.silly(`Getting transit policy response: '${JSON.stringify(response)}'.`);
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

    /**
     * Set active Transit Policy for device to OnlyCat API.
     *
     * @param {string} deviceId a device ID
     * @param {number} deviceTransitPolicyId a transit policy ID
     * @returns {Promise<void>}
     */
    setTransitPolicyForDevice(deviceId, deviceTransitPolicyId) {
        return new Promise((resolve, reject) => {
            if (this.adapterUnloaded) {
                reject(`Can not set active transit policy, adapter already unloaded.`);
            } else {
                this.log.debug(`Setting active transit policy '${deviceTransitPolicyId}' for device '${deviceId}'...`);
                this.api
                    .request('activateDeviceTransitPolicy', {
                        deviceId: deviceId,
                        deviceTransitPolicyId: deviceTransitPolicyId,
                    })
                    .then(response => {
                        this.log.silly(
                            `Setting active transit policy '${deviceTransitPolicyId}' for device '${deviceId}' response: '${JSON.stringify(response)}'.`,
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
     * Reset active Transit Policy for device to OnlyCat API.
     *
     * @param {number} deviceIndex a device index
     */
    resetTransitPolicyForDevice(deviceIndex) {
        const objName = `${this.devices[deviceIndex].description}.control.deviceTransitPolicyId`;
        const value = this.devices[deviceIndex].deviceTransitPolicyId;

        this.log.debug(
            `resetting deviceTransitPolicyId for device '${this.devices[deviceIndex].description}' to: '${value}'`,
        );
        this.setState(objName, value, true).catch(error => {
            this.log.error(
                `Could not reset deviceTransitPolicyId for device '${this.devices[deviceIndex].description}' because: '${error}'`,
            );
        });
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
            this.getAdapterVersionFromAdapter()
                .then(version => this.removeDeprecatedDataFromAdapter(version))
                .then(() => this.createDeviceHierarchyToAdapter())
                .then(() => this.createEventHierarchyToAdapter())
                .then(() => this.createPetHierarchyToAdapter())
                .then(() => this.createTransitPolicyHierarchyToAdapter())
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
     * Creates device hierarchy data structures to the adapter.
     *
     * @returns {Promise<void>}
     */
    createDeviceHierarchyToAdapter() {
        return new Promise((resolve, reject) => {
            const promiseArray = [];

            // create devices
            for (let d = 0; d < this.devices.length; d++) {
                promiseArray.push(this.createDeviceHierarchyForDeviceToAdapter(d));
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
     * Creates device hierarchy data structures for a device to the adapter.
     *
     * @param {number} deviceIndex a device index within this.devices
     * @returns {Promise<void>}
     */
    createDeviceHierarchyForDeviceToAdapter(deviceIndex) {
        return new Promise((resolve, reject) => {
            const promiseArray = [];

            // create device
            const objName = this.devices[deviceIndex].description;

            this.setObjectNotExists(
                objName,
                this.buildDeviceObject(
                    `device '${this.devices[deviceIndex].description_org}' (${this.devices[deviceIndex].deviceId})`,
                ),
                () => {
                    this.setObjectNotExists(
                        `${objName}.connectivity`,
                        this.buildChannelObject(
                            `connectivity state of the device '${this.devices[deviceIndex].description_org}'`,
                        ),
                        () => {
                            this.setObjectNotExists(
                                `${objName}.control`,
                                this.buildChannelObject(
                                    `controllable states for device '${this.devices[deviceIndex].description_org}'`,
                                ),
                                () => {
                                    promiseArray.push(
                                        this.setObjectNotExistsAsync(
                                            `${objName}.deviceId`,
                                            this.buildStateObject('id of the device', 'text', 'string'),
                                        ),
                                        this.setObjectNotExistsAsync(
                                            `${objName}.description`,
                                            this.buildStateObject('description of the device', 'text', 'string'),
                                        ),
                                        this.setObjectNotExistsAsync(
                                            `${objName}.firmwareChannel`,
                                            this.buildStateObject('firmwareChannel of the device', 'text', 'string'),
                                        ),
                                        this.setObjectNotExistsAsync(
                                            `${objName}.timeZone`,
                                            this.buildStateObject('timeZone of the device', 'text', 'string'),
                                        ),
                                        this.setObjectNotExistsAsync(
                                            `${objName}.cursorId`,
                                            this.buildStateObject('cursorId of the device', 'text', 'number'),
                                        ),
                                        this.setObjectNotExistsAsync(
                                            `${objName}.connectivity.connected`,
                                            this.buildStateObject('is the device connected'),
                                        ),
                                        this.setObjectNotExistsAsync(
                                            `${objName}.connectivity.disconnectReason`,
                                            this.buildStateObject('disconnect reason', 'text', 'string'),
                                        ),
                                        this.setObjectNotExistsAsync(
                                            `${objName}.connectivity.timestamp`,
                                            this.buildStateObject('timestamp', 'date', 'string'),
                                        ),
                                        this.setObjectNotExistsAsync(
                                            `${objName}.control.deviceTransitPolicyId`,
                                            this.buildStateObject(
                                                'deviceTransitPolicyId of the device',
                                                'text',
                                                'number',
                                                false,
                                            ),
                                        ),
                                    );

                                    Promise.all(promiseArray)
                                        .then(() => {
                                            return resolve();
                                        })
                                        .catch(error => {
                                            this.log.warn(`Could not create adapter device hierarchy (${error}).`);
                                            return reject();
                                        });
                                },
                            );
                        },
                    );
                },
            );
        });
    }

    /**
     * Creates event hierarchy data structures in the adapter.
     *
     * @returns {Promise<void>}
     */
    createEventHierarchyToAdapter() {
        return new Promise((resolve, reject) => {
            const promiseArray = [];
            for (let d = 0; d < this.devices.length; d++) {
                const objName = this.devices[d].description;
                promiseArray.push(
                    this.createEventsAsJsonToAdapter(objName),
                    this.createEventsAsStateObjectsToAdapter(objName),
                );
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
                    this.setObjectNotExistsAsync(
                        `${objName}.deviceId`,
                        this.buildStateObject('Device ID', 'text', 'string'),
                    ),
                    this.setObjectNotExistsAsync(
                        `${objName}.eventClassification`,
                        this.buildStateObject('Event classification', 'text', 'number', true, EVENT_CLASSIFICATION),
                    ),
                    this.setObjectNotExistsAsync(
                        `${objName}.eventId`,
                        this.buildStateObject('Event ID', 'text', 'number'),
                    ),
                    this.setObjectNotExistsAsync(
                        `${objName}.eventTriggerSource`,
                        this.buildStateObject('Event trigger source', 'text', 'number', true, EVENT_TRIGGER_SOURCE),
                    ),
                    this.setObjectNotExistsAsync(
                        `${objName}.frameCount`,
                        this.buildStateObject('Frame count', 'text', 'number'),
                    ),
                    this.setObjectNotExistsAsync(
                        `${objName}.globalId`,
                        this.buildStateObject('Global ID', 'text', 'number'),
                    ),
                    this.setObjectNotExistsAsync(
                        `${objName}.posterFrameIndex`,
                        this.buildStateObject('Poster frame index', 'text', 'number'),
                    ),
                    this.setObjectNotExistsAsync(
                        `${objName}.rfidCodes`,
                        this.buildStateObject('RFID codes', 'list', 'array'),
                    ),
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

    /**
     * Creates pet hierarchy data structures in the adapter.
     *
     * @returns {Promise<void>}
     */
    createPetHierarchyToAdapter() {
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
     * Creates transit policies hierarchy data structures in the adapter.
     *
     * @returns {Promise<void>}
     */
    createTransitPolicyHierarchyToAdapter() {
        return new Promise((resolve, reject) => {
            const promiseArray = [];
            for (let d = 0; d < this.devices.length; d++) {
                promiseArray.push(this.createTransitPolicyHierarchyForDeviceToAdapter(d));
                promiseArray.push(this.removeDeletedTransitPoliciesForDeviceFromAdapter(d));
            }
            Promise.all(promiseArray)
                .then(() => {
                    return resolve();
                })
                .catch(error => {
                    this.log.warn(`Could not create adapter transit policies hierarchy (${error}).`);
                    return reject();
                });
        });
    }

    /**
     * Creates transit policies hierarchy data structures for a device in the adapter.
     *
     * @param {number} deviceIndex a device index of the devices array
     * @returns {Promise<void>}
     */
    createTransitPolicyHierarchyForDeviceToAdapter(deviceIndex) {
        return new Promise((resolve, reject) => {
            const promiseArray = [];
            const deviceName = this.devices[deviceIndex].description;
            this.setObjectNotExists(
                `${deviceName}.transitPolicies`,
                this.buildChannelObject('transit policies of the device'),
                () => {
                    for (let i = 0; i < this.transitPolicyIds.length; i++) {
                        promiseArray.push(
                            this.createTransitPolicyForDeviceToAdapter(deviceIndex, this.transitPolicyIds[i]),
                        );
                    }
                    Promise.all(promiseArray)
                        .then(() => {
                            return resolve();
                        })
                        .catch(error => {
                            this.log.warn(`Could not create adapter transit policies hierarchy (${error}).`);
                            return reject();
                        });
                },
            );
        });
    }

    /**
     * Creates transit policies hierarchy data structures for a device in the adapter.
     *
     * @param {number} deviceIndex a device index of the devices array
     * @param {number} policyId a transit policy ID
     * @returns {Promise<void>}
     */
    createTransitPolicyForDeviceToAdapter(deviceIndex, policyId) {
        return new Promise((resolve, reject) => {
            const promiseArray = [];
            const deviceName = this.devices[deviceIndex].description;
            const policyName = this.transitPolicies[policyId].name;
            const objName = `${deviceName}.transitPolicies.${policyName}`;
            this.setObjectNotExists(
                objName,
                this.buildFolderObject(`transit policy '${policyName}' (${policyId})`),
                () => {
                    promiseArray.push(
                        this.setObjectNotExistsAsync(
                            `${objName}.deviceTransitPolicyId`,
                            this.buildStateObject('transit policy ID', 'text', 'number'),
                        ),
                        this.setObjectNotExistsAsync(
                            `${objName}.deviceId`,
                            this.buildStateObject('device ID', 'text', 'string'),
                        ),
                        this.setObjectNotExistsAsync(
                            `${objName}.name`,
                            this.buildStateObject('transit policy name', 'text', 'string'),
                        ),
                        this.setObjectNotExistsAsync(
                            `${objName}.transitPolicy`,
                            this.buildStateObject('transit policy json', 'json', 'string'),
                        ),
                        this.setObjectNotExistsAsync(
                            `${objName}.active`,
                            this.buildStateObject('is transit policy active'),
                        ),
                    );
                    Promise.all(promiseArray)
                        .then(() => {
                            return resolve();
                        })
                        .catch(error => {
                            this.log.warn(
                                `Could not create adapter transit policy hierarchy for device '${this.devices[deviceIndex].deviceId}' and transit policy '${policyId}' (${error}).`,
                            );
                            return reject();
                        });
                },
            );
        });
    }

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
            this.log.debug(`Updating all devices...`);
            if (this.devices) {
                const promiseArray = [];
                for (let d = 0; d < this.devices.length; d++) {
                    promiseArray.push(this.updateDevice(d));
                }
                Promise.all(promiseArray)
                    .then(() => {
                        this.log.debug(`All devices updated.`);
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not update all devices (${error}).`);
                        return resolve();
                    });
            } else {
                return reject(new Error(`no device data found.`));
            }
        });
    }

    /**
     * Update devices for given device IDs with the received data.
     *
     * @param {Array} deviceIds an array of device IDs
     * @returns {Promise<void>}
     */
    updateDevicesForDeviceIds(deviceIds) {
        return new Promise((resolve, reject) => {
            this.log.debug(`Updating devices...`);
            if (this.devices) {
                const promiseArray = [];
                for (let d = 0; d < this.devices.length; d++) {
                    if (deviceIds.includes(this.devices[d].deviceId)) {
                        promiseArray.push(this.updateDevice(d));
                    }
                }
                Promise.all(promiseArray)
                    .then(() => {
                        this.log.debug(`Devices updated.`);
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not update devices (${error}).`);
                        return resolve();
                    });
            } else {
                return reject(new Error(`no device data found.`));
            }
        });
    }

    /**
     * Update a device with the received data.
     *
     * @param {number} deviceIndex a device index within this.devices
     * @returns {Promise<void>}
     */
    updateDevice(deviceIndex) {
        return new Promise((resolve, reject) => {
            if (this.devices[deviceIndex] && 'description' in this.devices[deviceIndex]) {
                const promiseArray = [];
                const objName = this.devices[deviceIndex].description;
                const objNameCon = `${objName}.connectivity`;
                promiseArray.push(
                    this.setState(`${objName}.deviceId`, this.devices[deviceIndex].deviceId, true),
                    this.setState(`${objName}.description`, this.devices[deviceIndex].description, true),
                    this.setState(`${objName}.firmwareChannel`, this.devices[deviceIndex].firmwareChannel, true),
                    this.setState(`${objName}.timeZone`, this.devices[deviceIndex].timeZone, true),
                    this.setState(`${objName}.cursorId`, this.devices[deviceIndex].cursorId, true),
                    this.setState(`${objNameCon}.connected`, this.devices[deviceIndex].connectivity.connected, true),
                    this.setState(
                        `${objNameCon}.disconnectReason`,
                        this.devices[deviceIndex].connectivity.disconnectReason,
                        true,
                    ),
                    this.setState(`${objNameCon}.timestamp`, this.devices[deviceIndex].connectivity.timestamp, true),
                    this.setState(
                        `${objName}.control.deviceTransitPolicyId`,
                        this.devices[deviceIndex].deviceTransitPolicyId,
                        true,
                    ),
                );
                Promise.all(promiseArray)
                    .then(() => {
                        return resolve();
                    })
                    .catch(error => {
                        this.log.warn(`Could not update all states for device at index '${deviceIndex}' (${error}).`);
                        return resolve();
                    });
            } else {
                return reject(new Error(`no device at index '${deviceIndex}' found.`));
            }
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
     * Updates the transit policies.
     *
     * @returns {Promise<void>}
     */
    updateTransitPolicies() {
        return new Promise((resolve, reject) => {
            if (Array.isArray(this.devices)) {
                if (Array.isArray(this.transitPolicyIds) && Array.isArray(this.transitPolicies)) {
                    this.log.debug(`Updating transit policies...`);
                    const promiseArray = [];
                    for (let d = 0; d < this.devices.length; d++) {
                        promiseArray.push(this.updateTransitPoliciesForDevice(d));
                    }
                    Promise.all(promiseArray)
                        .then(() => {
                            this.log.debug(`Transit policies updated.`);
                            return resolve();
                        })
                        .catch(error => {
                            this.log.warn(`Could not update transit policies (${error}).`);
                            return reject();
                        });
                } else {
                    return reject(new Error(`no transit policies data found.`));
                }
            } else {
                return reject(new Error(`no device data found.`));
            }
        });
    }

    /**
     * Updates the transit policies for the given device IDs.
     *
     * @param {Array} deviceIds an array of device IDs
     * @returns {Promise<void>}
     */
    updateTransitPoliciesForDeviceIds(deviceIds) {
        return new Promise((resolve, reject) => {
            if (Array.isArray(this.devices)) {
                if (Array.isArray(this.transitPolicyIds) && Array.isArray(this.transitPolicies)) {
                    this.log.debug(`Updating transit policies for ${deviceIds.length} devices...`);
                    const promiseArray = [];
                    for (let d = 0; d < this.devices.length; d++) {
                        if (deviceIds.includes(this.devices[d].deviceId)) {
                            promiseArray.push(this.updateTransitPoliciesForDevice(d));
                        }
                    }
                    Promise.all(promiseArray)
                        .then(() => {
                            this.log.debug(`Transit policies updated for ${promiseArray.length} devices.`);
                            return resolve();
                        })
                        .catch(error => {
                            this.log.warn(`Could not update transit policies (${error}).`);
                            return reject();
                        });
                } else {
                    return reject(new Error(`no transit policies data found.`));
                }
            } else {
                return reject(new Error(`no device data found.`));
            }
        });
    }

    /**
     * Updates the transit policies for a device.
     *
     * @param {number} deviceIndex a device index
     * @returns {Promise<void>}
     */
    updateTransitPoliciesForDevice(deviceIndex) {
        return new Promise((resolve, reject) => {
            if (Array.isArray(this.devices)) {
                if (Array.isArray(this.transitPolicyIds) && Array.isArray(this.transitPolicies)) {
                    const deviceId = this.devices[deviceIndex].deviceId;
                    const deviceDescription = this.devices[deviceIndex].description;
                    this.log.debug(`Updating transit policies for device '${deviceId}'...`);
                    const promiseArray = [];
                    for (let i = 0; i < this.transitPolicyIds.length; i++) {
                        const policyId = this.transitPolicyIds[i];
                        if (this.transitPolicies[policyId].deviceId === deviceId) {
                            const policyName = this.transitPolicies[policyId].name;
                            const objName = `${deviceDescription}.transitPolicies.${policyName}`;
                            promiseArray.push(
                                this.setState(`${objName}.deviceTransitPolicyId`, policyId, true),
                                this.setState(`${objName}.deviceId`, deviceId, true),
                                this.setState(`${objName}.name`, this.transitPolicies[policyId].name_org, true),
                                this.setState(
                                    `${objName}.transitPolicy`,
                                    JSON.stringify(this.transitPolicies[policyId].transitPolicy),
                                    true,
                                ),
                                this.setState(
                                    `${objName}.active`,
                                    this.devices[deviceIndex].deviceTransitPolicyId === policyId,
                                    true,
                                ),
                            );
                        }
                    }
                    Promise.all(promiseArray)
                        .then(() => {
                            this.log.debug(
                                `Transit policies for device '${this.devices[deviceIndex].deviceId}' updated.`,
                            );
                            return resolve();
                        })
                        .catch(error => {
                            this.log.warn(
                                `Could not update transit policies for device '${this.devices[deviceIndex].deviceId}' (${error}).`,
                            );
                            return reject();
                        });
                } else {
                    return reject(new Error(`no transit policies data found.`));
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

    /***************************************
     * methods to get objects from adapter *
     ***************************************/

    /**
     * reads adapter version from the adapter
     *
     * @returns {Promise} Promise of a version string
     */
    getAdapterVersionFromAdapter() {
        return new Promise(resolve => {
            this.getStateValueFromAdapter('info.version')
                .then(version => {
                    if (version === undefined || version === null) {
                        this.log.silly(`getting adapter version failed because it was null or empty`);
                        this.log.debug(`last running adapter version is unknown.`);
                        return resolve('unknown');
                    }
                    this.log.debug(`last running adapter version is '${version}'.`);
                    return resolve(version);
                })
                .catch(err => {
                    this.log.silly(`getting adapter version failed because '${err}'`);
                    this.log.debug(`last running adapter version is unknown.`);
                    return resolve('unknown');
                });
        });
    }

    /**
     * reads a state value from the adapter
     *
     * @param {string} objName an object name
     * @returns {Promise} Promise of an adapter state value
     */
    getStateValueFromAdapter(objName) {
        return new Promise((resolve, reject) => {
            this.getState(objName, (err, obj) => {
                if (obj) {
                    return resolve(obj.val);
                }
                return reject(err);
            });
        });
    }

    /**
     * gets an object by pattern and type
     *
     * @param {string} pattern a object pattern
     * @param {object} type a object type
     * @param {boolean} recursive whether to get objects recursive
     * @returns {Promise} Promise of objects
     */
    getObjectsByPatternAndType(pattern, type, recursive) {
        return new Promise((resolve, reject) => {
            this.getForeignObjects(pattern, type, [], (err, obj) => {
                if (!err && obj) {
                    if (recursive === false) {
                        const level = pattern.split('.').length;
                        const newObj = {};
                        Object.keys(obj).forEach(key => {
                            if (obj[key]._id.split('.').length === level) {
                                newObj[key] = obj[key];
                            }
                        });
                        resolve(newObj);
                    } else {
                        resolve(obj);
                    }
                } else {
                    reject(err);
                }
            });
        });
    }

    /**********************************************
     * methods to delete objects from the adapter *
     **********************************************/

    /**
     * Removes deleted or renamed transit policies.
     *
     * @param {number} deviceIndex a device index
     * @returns {Promise<void>}
     */
    removeDeletedTransitPoliciesForDeviceFromAdapter(deviceIndex) {
        return new Promise((resolve, reject) => {
            if (Array.isArray(this.devices)) {
                if (Array.isArray(this.transitPolicyIds) && Array.isArray(this.transitPolicies)) {
                    this.log.debug(
                        `Removing deleted or renamed transit policies for device '${this.devices[deviceIndex].deviceId}'...`,
                    );
                    const promiseArray = [];
                    const deviceId = this.devices[deviceIndex].deviceId;
                    const existingTransitPolicies = [];
                    for (let i = 0; i < this.transitPolicyIds.length; i++) {
                        const policyId = this.transitPolicyIds[i];
                        if (this.transitPolicies[policyId].deviceId === deviceId) {
                            existingTransitPolicies.push(
                                `transit policy '${this.transitPolicies[policyId].name}' (${policyId})`,
                            );
                        }
                    }
                    promiseArray.push(
                        this.getObjectsByPatternAndType(
                            `${this.name}.${this.instance}.${this.devices[deviceIndex].description}.transitPolicies.*`,
                            'folder',
                            false,
                        ),
                    );
                    Promise.all(promiseArray)
                        .then(objs => {
                            const deletePromiseArray = [];
                            objs.forEach(obj => {
                                if (obj) {
                                    Object.keys(obj).forEach(key => {
                                        if (!existingTransitPolicies.includes(obj[key].common.name)) {
                                            this.log.debug(
                                                `deleted or renamed transit policy ${obj[key]._id} (${obj[key].common.name}) found. trying to delete (${obj[key].type})`,
                                            );
                                            deletePromiseArray.push(
                                                this.deleteObjectFormAdapterIfExists(obj[key]._id, true),
                                            );
                                        }
                                    });
                                }
                            });
                            Promise.all(deletePromiseArray)
                                .then(() => {
                                    this.log.debug(`Deleted or renamed transit policies removed.`);
                                    return resolve();
                                })
                                .catch(error => {
                                    this.log.warn(`Could not remove deleted or renamed transit policies (${error}).`);
                                    return reject();
                                });
                        })
                        .catch(error => {
                            this.log.warn(`Could not remove deleted or renamed transit policies (${error}).`);
                            return reject();
                        });
                } else {
                    return reject(new Error(`no transit policies data found.`));
                }
            } else {
                return reject(new Error(`no device data found.`));
            }
        });
    }

    /**
     * removes obsolete data structures from the adapter
     * When there are changes to the data structures obsolete entries go here.
     *
     * @param {string} version a version string in format patch.major.minor or 'unknown'
     * @returns {Promise<void>} a promise
     */
    removeDeprecatedDataFromAdapter(version) {
        return new Promise(resolve => {
            const deletePromiseArray = [];

            if (ADAPTER_VERSION !== version && version !== 'unknown') {
                this.log.info(`adapter was upgraded from '${version}' to '${ADAPTER_VERSION}'.`);
            }

            this.log.debug(`searching and removing of obsolete objects`);

            if (version === 'unknown' || this.isVersionLessThan(version, '0.5.0')) {
                this.log.debug(`searching and removing of obsolete objects for adapter versions before 0.5.0`);

                // DEVICE.deviceTransitPolicyId is moved to DEVICE.control.deviceTransitPolicyId
                for (let d = 0; d < this.devices.length; d++) {
                    const objName = this.devices[d].description;
                    deletePromiseArray.push(
                        this.deleteObjectFormAdapterIfExists(`${objName}.deviceTransitPolicyId`, false),
                    );
                }
            }

            Promise.all(deletePromiseArray)
                .then(() => {
                    this.log.debug(`searching and removing of obsolete objects complete`);
                    return resolve();
                })
                .catch(() => {
                    this.log.warn(
                        `searching and removing of obsolete objects failed. some obsolete objects may not have been removed.`,
                    );
                    return resolve();
                });
        });
    }

    /**
     * deletes an object from the adapter if it exists
     *
     * @param {string} objName an object name
     * @param {boolean} recursive whether to delete objects recursive
     * @returns {Promise<void>} a promise
     */
    deleteObjectFormAdapterIfExists(objName, recursive) {
        return new Promise((resolve, reject) => {
            this.log.silly(`deleting object '${objName}'`);
            this.getObject(objName, (err, obj) => {
                if (!err && obj) {
                    this.log.silly(`found object '${objName}'. trying to delete ...`);
                    this.delObject(obj._id, { recursive: recursive }, err => {
                        if (err) {
                            this.log.error(`could not delete object '${objName}' (${err})`);
                            return reject();
                        }
                        this.log.silly(`deleted object '${objName}'`);
                        return resolve();
                    });
                } else {
                    this.log.silly(`object '${objName}' not found`);
                    return resolve();
                }
            });
        });
    }

    /******************
     * helper methods *
     ******************/

    /**
     * Extracts all device IDs from this.devices
     *
     * @returns {Array} an array of device IDs
     */
    getAllDeviceIds() {
        let deviceIds = [];
        for (let d = 0; d < this.devices.length; d++) {
            if ('deviceId' in this.devices[d]) {
                deviceIds.push(this.devices[d].deviceId);
            }
        }
        return deviceIds;
    }

    /**
     * compares two version strings in format patch.major.minor
     *
     * @param version a version string
     * @param lessThan a version string
     * @returns {boolean} true, if version is less than lessThan, false otherwise
     */
    isVersionLessThan(version, lessThan) {
        if (version === undefined || version === null || version === 'unknown' || version.split('.').length < 3) {
            return false;
        }
        if (lessThan === undefined || lessThan === null || lessThan === 'unknown' || lessThan.split('.').length < 3) {
            return false;
        }
        if (version === lessThan) {
            return false;
        }
        const versionObj = version.split('.');
        const lessThanObj = lessThan.split('.');
        return (
            parseInt(versionObj[0]) < parseInt(lessThanObj[0]) ||
            (versionObj[0] === lessThanObj[0] && parseInt(versionObj[1]) < parseInt(lessThanObj[1])) ||
            (versionObj[0] === lessThanObj[0] &&
                versionObj[1] === lessThanObj[1] &&
                parseInt(versionObj[2]) < parseInt(lessThanObj[2]))
        );
    }

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
     * Returns the device index within the devices array for the given device description.
     *
     * @param {string} description a device description
     * @returns {undefined|number} the device index if it exists, otherwise undefined
     */
    getDeviceIndexForDeviceDescription(description) {
        for (let d = 0; d < this.devices.length; d++) {
            if (this.devices[d].description === description) {
                return d;
            }
        }
        return undefined;
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
