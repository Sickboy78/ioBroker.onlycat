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
// const fs = require("fs");
const util = require('util');
const OnlyCatApi = require('./lib/onlycat-api');

const ADAPTER_VERSION = '0.0.1';
// Constants - data update frequency
const RETRY_FREQUENCY_CONNECT = 60;

class Template extends utils.Adapter {

	/**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
	constructor(options) {
		super({
			...options,
			name: 'onlycat',
		});

		this.api = new OnlyCatApi(this);
		this.connectionStatusSubcription = undefined;

		// class variables
		// reconnect timer
		this.timerId = undefined;
		// adapter unloaded
		this.adapterUnloaded = false;
		// last error
		this.lastError = undefined;

		/* current and previous data from onlycat API */
		// list of devices
		this.devices = {};
		// list of events
		this.events = {};

		// promisify setObjectNotExists
		this.setObjectNotExistsPromise = util.promisify(this.setObjectNotExists);

		this.on('ready', this.onReady.bind(this));
		//this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
     * Is called when databases are connected and adapter received configuration.
     */
	async onReady() {
		// Initialize your adapter here

		// Reset the connection indicator during startup
		this.setConnectionStatusToAdapter(false);

		// check adapter config for invalid values
		this.checkAdapterConfig();

		// connect to OnlyCat API via socket.io and retrieve data
		this.log.debug(`Starting OnlyCat Adapter v` + ADAPTER_VERSION);
		this.connectToApiAndStartRetrievingData();
	}

	/**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
	onUnload(callback) {
		try {
			this.adapterUnloaded = true;
			clearTimeout(this.timerId);
			this.timerId = undefined;
			if(this.connectionStatusSubcription !== undefined) {
				this.connectionStatusSubcription.unsubscribe();
				this.connectionStatusSubcription = undefined;
			}
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

	// /**
	//  * Is called if a subscribed state changes
	//  * @param {string} id
	//  * @param {ioBroker.State | null | undefined} state
	//  */
	// onStateChange(id, state) {
	//     if (state) {
	//         // The state was changed
	//         this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
	//     } else {
	//         // The state was deleted
	//         this.log.info(`state ${id} deleted`);
	//     }
	// }

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

	/****************************************************************
	 * methods to start and keep communicating with the OnlyCat API *
	 ****************************************************************/

	/**
	 * starts loading data from the OnlyCat API
	 */
	connectToApiAndStartRetrievingData() {
		if(this.timerId !== undefined) {
			clearTimeout(this.timerId);
			this.timerId = undefined;
		}
		this.setConnectionStatusToAdapter(false);
		this.log.info(`Connecting...`);
		this.connectToApi()
			.then(() => this.getDevices())
			.then(() => this.getEvents())
			.then(() => this.createAdapterObjectHierarchy())
			.then(() => this.updateDevices())
			.then(() => this.updateEvents())
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
				this.reconnect();
			});
	}

	/*******************************************
     * methods to communicate with OnlyCat API *
     *******************************************/

	connectToApi() {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			const connectingSubscription = this.api.connectionState$.subscribe(connectionState => {
				if(connectionState === this.api.ConnectionState.Disconnected) {
					this.log.debug(`New initial connection state: '${connectionState}'`);
					connectingSubscription.unsubscribe();
					this.api.closeConnection();
					reject(`Connection to OnlyCat API failed.`);
				}
				if(connectionState === this.api.ConnectionState.Connected) {
					this.setConnectionStatusToAdapter(true);
					this.log.info(`Connected.`);
					connectingSubscription.unsubscribe();
					if(this.connectionStatusSubcription !== undefined) {
						this.connectionStatusSubcription.unsubscribe();
					}
					this.connectionStatusSubcription = this.api.connectionState$.subscribe(connectionState => this.onConnectionStateChange(connectionState));
					resolve();
				} else {
					this.log.debug(`New initial connection state: '${connectionState}'`);
				}
			});
			this.api.initConnection();
		}));
	}

	/**
	 * Connection state change handler
	 *
     * @param {string} connectionState
     */
	onConnectionStateChange(connectionState) {
		this.log.debug(`New connection state: '${connectionState}'`);
		if(connectionState === this.api.ConnectionState.Connected) {
			if(this.timerId !== undefined) {
				clearTimeout(this.timerId);
				this.timerId = undefined;
			}
		}
		if(connectionState === this.api.ConnectionState.Disconnected) {
			this.log.info(`Disconnected.`);
			this.reconnect();
		}
	}

	reconnect() {
		if (!this.adapterUnloaded) {
			if (this.api.isReconnecting()) {
				this.log.info(`Automatic Reconnecting is active.`);
			} else {
				if(this.connectionStatusSubcription !== undefined) {
					this.connectionStatusSubcription.unsubscribe();
				}
				this.api.closeConnection();
				this.log.info(`Reconnecting in ${RETRY_FREQUENCY_CONNECT} seconds.`);
				if(this.timerId !== undefined) {
					clearTimeout(this.timerId);
					this.timerId = undefined;
				}
				// @ts-ignore
				this.timerId = setTimeout(this.connectToApiAndStartRetrievingData.bind(this), RETRY_FREQUENCY_CONNECT * 1000);
			}
		}
	}

	/**
	 * subscribe to events
	 *
	 * @return {Promise}
	 */
	subscribeEvents() {
		return /** @type {Promise<void>} */(new Promise((resolve) => {
			this.log.info(`Subscribing to events...`);
			this.api.subscribeToEvent('userEventUpdate', (/** @type {any} */ data) => this.onEventReceived(data));
			this.log.info(`Events subscribed.`);
			return resolve();
		}));
	}

	/**
     * Handles received events
	 *
     * @param {any} data
     */
	onEventReceived(data) {
		this.log.info(`Received Event: ${JSON.stringify(data)}`);
		this.getEvents().then(() => this.updateEvents());
	}

	/***************************************************
	 * methods to get information from the surepet API *
	 ***************************************************/

	/**
     * get devices
     *
     * @return {Promise}
     */
	getDevices() {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			this.log.info(`Getting devices...`);
			this.api.request('getDevices',{ subscribe: true})
				.then((response) => {
					this.devices = response;
					this.log.info(this.devices.length === 1 ? `Got 1 device.` : `Got ${this.devices.length} devices.`);
					this.log.debug(`Getting devices response: '${JSON.stringify(response)}'.`);
					return resolve();
				})
				.catch(error => {
					reject(error);
				});
		}));
	}

	/**
     * get events
     *
     * @return {Promise}
     */
	getEvents() {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			this.log.info(`Getting events...`);
			this.api.request('getEvents',{ subscribe: true})
				.then((response) => {
					this.events = response;
					this.log.info(this.events.length <= 1 ? `Got ${this.events.length} event.` : `Got ${this.events.length} events.`);
					return resolve();
				})
				.catch(error => {
					reject(error);
				});
		}));
	}

	/************************************************
	 * methods to initially create object hierarchy *
	 ************************************************/

	/**
	 * creates the adapters object hierarchy
	 *
	 * @return {Promise}
	 */
	createAdapterObjectHierarchy() {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			this.log.debug(`Creating device hierarchy...`);
			this.createDevicesToAdapter()
				.then(() => this.createEventsToAdapter())
				.then(() => {
					this.log.debug(`Device hierarchy created.`);
					return resolve();
				})
				.catch(() => {
					this.log.error(`Creating device hierarchy failed.`);
					return reject();
				});
		}));
	}

	/**
     * creates device hierarchy data structures in the adapter
     *
     * @return {Promise}
     */
	createDevicesToAdapter() {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			const promiseArray = [];

			// create devices
			for (let d = 0; d < this.devices.length; d++) {
				const objName = this.devices[d].description.toLowerCase();

				this.setObjectNotExists(objName, this.buildDeviceObject('Device \'' + this.devices[d].description + '\' (' + this.devices[d].deviceId + ')'), () => {
					promiseArray.push(this.setObjectNotExistsPromise(objName + '.deviceId', this.buildStateObject('id of the device', 'text', 'string')));
					promiseArray.push(this.setObjectNotExistsPromise(objName + '.description', this.buildStateObject('description of the device', 'text', 'string')));
					promiseArray.push(this.setObjectNotExistsPromise(objName + '.timeZone', this.buildStateObject('timeZone of the device', 'text', 'string')));
					promiseArray.push(this.setObjectNotExistsPromise(objName + '.deviceTransitPolicyId', this.buildStateObject('deviceTransitPolicyId of the device', 'text', 'number')));
					promiseArray.push(this.setObjectNotExistsPromise(objName + '.cursorId', this.buildStateObject('cursorId of the device', 'text', 'number')));
				});
			}

			Promise.all(promiseArray).then(() => {
				return resolve();
			}).catch(error => {
				this.log.warn(`Could not create adapter device hierarchy (${error}).`);
				return reject();
			});
		}));
	}

	/**
     * creates event hierarchy data structures in the adapter
     *
     * @return {Promise}
     */
	createEventsToAdapter() {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			const promiseArray = [];
			for (let d = 0; d < this.devices.length; d++) {
				const objName = this.devices[d].description.toLowerCase();
				promiseArray.push(this.createEventsAsJsonToAdapter(objName));
				promiseArray.push(this.createEventsAsStateObjectsToAdapter(objName));
			}
			Promise.all(promiseArray).then(() => {
				return resolve();
			}).catch(error => {
				this.log.warn(`Could not create adapter events hierarchy (${error}).`);
				return reject();
			});
		}));
	}

	/**
     * creates events as json
	 *
	 * @param {string} objName
	 * @return {Promise}
     */
	createEventsAsJsonToAdapter(objName) {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			const promiseArray = [];
			this.setObjectNotExists(objName + '.jsonEvents', this.buildChannelObject('events in json format'), () => {
				for (let e = 0; e < 10; e++) {
					promiseArray.push(this.setObjectNotExistsPromise(objName + '.jsonEvents.' + (e + 1), this.buildStateObject('event ' + (e + 1), 'json', 'string')));
				}
				Promise.all(promiseArray).then(() => {
					return resolve();
				}).catch(error => {
					this.log.warn(`Could not create adapter events json hierarchy (${error}).`);
					return reject();
				});
			});
		}));
	}

	/**
     * creates events as state objects
	 *
	 * @param {string} objName
	 * @return {Promise}
	 */
	createEventsAsStateObjectsToAdapter(objName) {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			const promiseArray = [];
			this.setObjectNotExists(objName + '.events', this.buildChannelObject('events as state objects'), () => {
				for (let e = 0; e < 10; e++) {
					promiseArray.push(this.createEventStateObjectsToAdapter(objName + '.events.' + (e + 1), e));
				}
				Promise.all(promiseArray).then(() => {
					return resolve();
				}).catch(error => {
					this.log.warn(`Could not create adapter events objects hierarchy (${error}).`);
					return reject();
				});
			});
		}));
	}

	/**
     * creates an event as state objects
     *
     * @param {string} objName
     * @param {number} eventIndex
	 * @return {Promise}
     */
	createEventStateObjectsToAdapter(objName, eventIndex) {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			const promiseArray = [];
			this.setObjectNotExists(objName, this.buildFolderObject('event ' + (eventIndex + 1)), () => {
				promiseArray.push(this.setObjectNotExistsPromise(objName + '.accessToken', this.buildStateObject('Access token', 'text', 'string')));
				promiseArray.push(this.setObjectNotExistsPromise(objName + '.deviceId', this.buildStateObject('Device ID', 'text', 'string')));
				promiseArray.push(this.setObjectNotExistsPromise(objName + '.eventClassification', this.buildStateObject('Event classification', 'text', 'number')));
				promiseArray.push(this.setObjectNotExistsPromise(objName + '.eventId', this.buildStateObject('Event ID', 'text', 'number')));
				promiseArray.push(this.setObjectNotExistsPromise(objName + '.eventTriggerSource', this.buildStateObject('Event trigger source', 'text', 'number')));
				promiseArray.push(this.setObjectNotExistsPromise(objName + '.frameCount', this.buildStateObject('Frame count', 'text', 'number')));
				promiseArray.push(this.setObjectNotExistsPromise(objName + '.globalId', this.buildStateObject('Global ID', 'text', 'number')));
				promiseArray.push(this.setObjectNotExistsPromise(objName + '.posterFrameIndex', this.buildStateObject('Poster frame index', 'text', 'number')));
				promiseArray.push(this.setObjectNotExistsPromise(objName + '.rfidCodes', this.buildStateObject('RFID codes', 'list', 'array')));
				promiseArray.push(this.setObjectNotExistsPromise(objName + '.timestamp', this.buildStateObject('Timestamp', 'date', 'string')));

				Promise.all(promiseArray).then(() => {
					return resolve();
				}).catch(error => {
					this.log.warn(`Could not create adapter event objects (${error}).`);
					return reject();
				});
			});
		}));
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
     * update devices with the received data
     *
     * @return {Promise}
     */
	updateDevices() {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			if (this.devices) {
				for (let d = 0; d < this.devices.length; d++) {
					const objName = this.devices[d].description.toLowerCase();
					this.setState(objName + '.deviceId', this.devices[d].deviceId, true);
					this.setState(objName + '.description', this.devices[d].description, true);
					this.setState(objName + '.timeZone', this.devices[d].timeZone, true);
					this.setState(objName + '.deviceTransitPolicyId', this.devices[d].deviceTransitPolicyId, true);
					this.setState(objName + '.cursorId', this.devices[d].cursorId, true);
				}
				return resolve();
			} else {
				return reject(new Error(`no device data found.`));
			}
		}));
	}

	/**
     * update events with the received data
     *
     * @return {Promise}
     */
	updateEvents() {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			this.log.info(`Updating events...`);
			if (this.devices) {
				if (this.events) {
					for (let d = 0; d < this.devices.length; d++) {
						let eventNumber = 1;
						const objName = this.devices[d].description.toLowerCase();
						for (let e = 0; e < this.events.length; e++) {
							if(this.events[e].deviceId === this.devices[d].deviceId) {
								if(eventNumber <= 10) {
									this.setState(objName + '.jsonEvents.' + eventNumber, JSON.stringify(this.events[e]), true);
									this.setState(objName + '.events.' + eventNumber + '.accessToken', this.events[e].accessToken, true);
									this.setState(objName + '.events.' + eventNumber + '.deviceId', this.events[e].deviceId, true);
									this.setState(objName + '.events.' + eventNumber + '.eventClassification', this.events[e].eventClassification, true);
									this.setState(objName + '.events.' + eventNumber + '.eventId', this.events[e].eventId, true);
									this.setState(objName + '.events.' + eventNumber + '.eventTriggerSource', this.events[e].eventTriggerSource, true);
									this.setState(objName + '.events.' + eventNumber + '.frameCount', this.events[e].frameCount, true);
									this.setState(objName + '.events.' + eventNumber + '.globalId', this.events[e].globalId, true);
									this.setState(objName + '.events.' + eventNumber + '.posterFrameIndex', this.events[e].posterFrameIndex, true);
									this.setState(objName + '.events.' + eventNumber + '.rfidCodes', JSON.stringify(this.events[e].rfidCodes), true);
									this.setState(objName + '.events.' + eventNumber + '.timestamp', this.events[e].timestamp, true);
									eventNumber++;
								}
							}
						}
					}
					this.log.info(`Events updated.`);
					this.setLastUpdateToAdapter();
					return resolve();
				} else {
					return reject(new Error(`no event data found.`));
				}
			} else {
				return reject(new Error(`no device data found.`));
			}
		}));
	}

	/**
	 * updates the adapter version state on the first update loop
	 *
	 * @return {Promise}
	 */
	updateAdapterVersion() {
		return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
			if (!this.adapterUnloaded) {
				this.setAdapterVersionToAdapter(ADAPTER_VERSION);
				return resolve();
			} else {
				return reject(new Error(`cannot set adapter version. Adapter already unloaded.`));
			}
		}));
	}

	/**
	 * sets the current adapter version to the adapter
	 *
	 * @param {string} version
	 */
	setAdapterVersionToAdapter(version) {
		this.log.silly(`setting adapter version to adapter`);

		/* objects created via io-package.json, no need to create them here */
		this.setState('info.version', version, true);
	}

	/**
     * sets connection status to the adapter
     *
     * @param {boolean} connected
     */
	setConnectionStatusToAdapter(connected) {
		this.log.silly(`setting connection status to adapter`);

		/* objects created via io-package.json, no need to create them here	*/
		this.setState('info.connection', connected, true);
	}

	/**
	 * sets the last time data was received from OnlyCat API
	 */
	setLastUpdateToAdapter() {
		this.log.silly(`setting last update to adapter`);

		/* object created via io-package.json, no need to create them here */
		this.setState('info.last_update', new Date().toISOString(), true);
	}

	/******************
	 * helper methods *
	 ******************/

	/**
     * checks and logs the values of the adapter configuration and sets default values in case of invalid values
     */
	checkAdapterConfig() {
		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		let configOk = true;
		this.log.info(`checking adapter configuration...`);
		if (!this.config.token || typeof this.config.token !== 'string' || this.config.token.length === 0) {
			this.log.warn(`Token is invalid. Adapter probably won't work.`);
			configOk = false;
		}
		if (configOk) {
			this.log.info('adapter configuration ok');
		} else {
			this.log.info('adapter configuration contains errors');
		}
	}

	/**
	 * builds a state object
	 *
	 * @param {string} name
	 * @param {string} role
	 * @param {string} type
	 * @param {boolean} readonly
	 * @param {object} states
	 * @return {object}
	 */
	buildStateObject(name, role = 'indicator', type = 'boolean', readonly = true, states = undefined) {
		return states === undefined ? {
			type: 'state',
			common: {
				name: name,
				role: role,
				type: type,
				read: true,
				write: !readonly
			},
			native: {}
		} : {
			type: 'state',
			common: {
				name: name,
				role: role,
				type: type,
				read: true,
				write: !readonly,
				states: states
			},
			native: {}
		};
	}

	/**
	 * builds a device object
	 *
	 * @param {string} name
	 * @return {object}
	 */
	buildDeviceObject(name) {
		return {
			type: 'device',
			common: {
				name: name,
				role: ''
			},
			native: {}
		};
	}

	/**
	 * builds a channel object
	 *
	 * @param {string} name
	 * @return {object}
	 */
	buildChannelObject(name) {
		return {
			type: 'channel',
			common: {
				name: name,
				role: ''
			},
			native: {}
		};
	}

	/**
	 * builds a folder object
	 *
	 * @param {string} name
	 * @return {object}
	 */
	buildFolderObject(name) {
		return {
			type: 'folder',
			common: {
				name: name,
				role: ''
			},
			native: {}
		};
	}

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
	module.exports = (options) => new Template(options);
} else {
	// otherwise start the instance directly
	new Template();
}