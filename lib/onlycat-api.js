'use strict';

const SocketIO = require('socket.io-client');
const rxjs = require('rxjs');
const util = require('util');

class OnlyCatApi {

	ConnectionState = {
		Starting: 'STARTING',
		Disconnected: 'DISCONNECTED',
		Connecting: 'CONNECTING',
		Connected: 'CONNECTED',
		Reconnecting: 'RECONNECTING'
	};

	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter ioBroker adapter instance
	 */
	constructor(adapter) {
		this.adapter = adapter;
		this.requestId = 0;
		this.gatewayURL = `https://gateway.onlycat.com`;
		this.socket = undefined;

		this.connectionState$ = new rxjs.BehaviorSubject(this.ConnectionState.Disconnected);
		this.user$ = new rxjs.BehaviorSubject(undefined);
	}

	prepareConnection() {
		this.connectionState$ = new rxjs.BehaviorSubject(this.ConnectionState.Starting);
	}

	initConnection() {

		this.adapter.log.debug(`(${this.constructor.name}) Connecting to ${this.gatewayURL}`);

		this.connectionState$.next(this.ConnectionState.Connecting);

		this.socket = SocketIO.io(this.gatewayURL, {
			transports: ['websocket'],
			query: {
				platform: 'ioBroker',
				device: 'ionic-app'
			},
			auth: (async (cb) => {
				cb({
					token: this.adapter.config.token
				});
			})
		});

		this.socket.on('connect', () => {
			this.adapter.log.debug(`(${this.constructor.name}) Connected.`);
			this.connectionState$.next(this.ConnectionState.Connected);
		});

		this.socket.on('connect_error', (error) => {
			this.adapter.log.warn(`(${this.constructor.name}) Connect Error: ${error}`);
		});

		this.socket.on('disconnect', () => {
			this.adapter.log.warn(`(${this.constructor.name}) Disconnected.`);
			this.connectionState$.next(this.ConnectionState.Disconnected);
		});

		this.socket.io.on('reconnect_attempt', () => {
			this.adapter.log.debug(`(${this.constructor.name}) Reconnect attempt`);
			this.connectionState$.next(this.ConnectionState.Reconnecting);
		});

		this.socket.io.on('reconnect', () => {
			this.adapter.log.debug(`(${this.constructor.name}) Reconnect success`);
		});

		this.socket.on('userUpdate', (user) => {
			this.adapter.log.debug(`(${this.constructor.name}) UserUpdate: '${JSON.stringify(user.id)}'`);
			this.user$.next(user);
		});

	}

	closeConnection() {
		if (this.socket !== undefined) {
			this.socket.disconnect();
			this.socket = undefined;
			this.connectionState$.next(this.ConnectionState.Disconnected);
			this.user$.next(undefined);
		}
	}

	disconnectEngine() {
		if (this.socket && this.socket.io && this.socket.io.engine) {
			this.socket.io.engine.close();
		}
	}

	disconnectSocket() {
		if (this.socket) {
			this.socket.disconnect();
		}
	}

	/**
	 * Subscribes to an event
	 *
	 * @param {string} event
	 * @param {(data: any) => void} callback
	 */
	subscribeToEvent(event, callback) {
		if (this.socket !== undefined) {
			this.socket.on(event, callback);
		}
	}

	/**
	 * Unsubscribes from an event
	 *
	 * @param {string} event
	 */
	unsubscribeFromEvent(event) {
		if (this.socket !== undefined) {
			this.socket.off(event);
		}
	}

	isReconnecting() {
		if (this.socket !== undefined) {
			return this.socket.active;
		}
		return false;
	}

	/**
     * Sends a socket request
	 *
     * @param {any} event
     * @param {any} args
     * @return {Promise<*>}
     */
	async socketRequest(event, ...args) {
		const requestId = ++this.requestId;

		return new Promise((resolve, reject) => {
			if (this.socket !== undefined) {
				this.adapter.log.debug(`(${this.constructor.name}) [${requestId}] -> event: '${util.inspect(event)}' - args: '${util.inspect(args)}'`);

				const disconnectHandler = () => {
					this.adapter.log.debug(`(${this.constructor.name}) [${requestId}] <-x- DISCONNECTED`);

					reject({
						code: 1006,
						message: 'Disconnected'
					});
				};

				const timeoutHandler = () => {
					this.adapter.log.warn(`(${this.constructor.name}) [${requestId}] <-?- Request Timeout?`);
				};

				this.socket.once('disconnect', disconnectHandler);
				const timeout = setTimeout(timeoutHandler, 30000);

				this.socket.emit(event, ...args, (/** @type any */ response) => {
					if (this.socket !== undefined) {
						this.socket.off('disconnect', disconnectHandler);
						clearInterval(timeout);

						let responseString = util.inspect(response);
						responseString = responseString.length > 200 ? responseString.substring(0,200) + '...' : responseString;
						this.adapter.log.debug(`(${this.constructor.name}) [${requestId}] <- event: '${util.inspect(event)}' - response: '${responseString}'`);

						if (response?.code && response.code !== 200) {
							this.adapter.log.error(`(${this.constructor.name}) Error: event '${util.inspect(event)}' - response: '${util.inspect(response)}'`);
							reject(response);
						}

						resolve(response);
					} else {
						reject('Call to socket.emit before socket was initialized. Call init first!');
					}
				});
			} else {
				reject('Call to socketRequest before socket was initialized. Call init first!');
			}
		});
	}

	/**
	 * Alias for socketRequest
	 *
     * @param {string} event
     * @param {any[]} args
     * @return {Promise<*>}
     */
	async request(event, ...args) {
		return this.socketRequest(event, ...args);
	}

	/*
	async httpRequest(method, path, data) {
		return await fetch(this.apiURL + path, {
			method: method,
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});
	}
	*/
}

module.exports = OnlyCatApi;