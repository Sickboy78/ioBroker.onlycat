'use strict';

const sinon = require('sinon');
const proxyquire = require('proxyquire');

class MockOnlyCatApi {
    constructor() {
        this.request = sinon.stub();
    }
}

class MockAdapter {
    constructor(options) {
        this.log = {
            debug: sinon.stub(),
            error: sinon.stub(),
            silly: sinon.stub(),
            warn: sinon.stub(),
            info: sinon.stub(),
        };
        this.adapterUnloaded = false;
    }
    on() {}
}

const createAdapter = proxyquire('./main', {
    '@iobroker/adapter-core': { Adapter: MockAdapter, '@noCallThru': true },
    './lib/onlycat-api': Object.assign(MockOnlyCatApi, { '@noCallThru': true }),
});

describe('OnlyCat Adapter => getDevices()', () => {
    let adapter;

    beforeEach(() => {
        adapter = createAdapter({});
    });

    it('should resolve and store valid devices', async () => {
        const devices = [
            { deviceId: 'dev1', description: 'CatFlapFront' },
            { deviceId: 'dev2', description: 'CatFlapBack' },
        ];
        adapter.api.request.resolves(devices);

        await adapter.getDevices();

        adapter.devices.should.have.length(2);
        adapter.devices[0].deviceId.should.equal('dev1');
        adapter.devices[1].deviceId.should.equal('dev2');
    });

    it('should filter out devices without a deviceId and log an error for each', async () => {
        const devices = [
            { deviceId: 'dev1', description: 'CatFlap' },
            { description: 'NoIdDevice' },
            { deviceId: '', description: 'EmptyIdDevice' },
        ];
        adapter.api.request.resolves(devices);

        await adapter.getDevices();

        adapter.devices.should.have.length(1);
        adapter.devices[0].deviceId.should.equal('dev1');
        adapter.log.error.should.have.been.calledTwice;
    });

    it('should fall back to deviceId when description is missing', async () => {
        adapter.api.request.resolves([{ deviceId: 'dev1' }]);

        await adapter.getDevices();

        adapter.devices[0].description.should.equal('dev1');
        adapter.log.error.should.have.been.calledOnce;
    });

    it('should fall back to deviceId when description is null', async () => {
        adapter.api.request.resolves([{ deviceId: 'dev1', description: null }]);

        await adapter.getDevices();

        adapter.devices[0].description.should.equal('dev1');
        adapter.log.error.should.have.been.calledOnce;
    });

    it('should fall back to deviceId when description is empty', async () => {
        adapter.api.request.resolves([{ deviceId: 'dev1', description: '' }]);

        await adapter.getDevices();

        adapter.devices[0].description.should.equal('dev1');
        adapter.log.error.should.have.been.calledOnce;
    });

    it('should normalize the description and preserve the original', async () => {
        adapter.api.request.resolves([{ deviceId: 'dev1', description: 'My Cat Flap!' }]);

        await adapter.getDevices();

        adapter.devices[0].description.should.equal('My_Cat_Flap_');
        adapter.devices[0].description_org.should.equal('My Cat Flap!');
        adapter.log.debug.should.have.been.calledWith(sinon.match('Normalizing device name'));
    });

    it('should not log normalization when description does not change', async () => {
        adapter.api.request.resolves([{ deviceId: 'dev1', description: 'MyCatFlap' }]);

        await adapter.getDevices();

        adapter.devices[0].description.should.equal('MyCatFlap');
        adapter.log.debug.should.not.have.been.calledWith(sinon.match('Normalizing device name'));
    });

    it('should reject when the adapter is already unloaded', async () => {
        adapter.adapterUnloaded = true;

        return adapter.getDevices().should.be.rejectedWith('Can not get devices, adapter already unloaded.');
    });

    it('should reject when the API call fails', async () => {
        adapter.api.request.rejects(new Error('network error'));

        return adapter.getDevices().should.be.rejectedWith('network error');
    });
});