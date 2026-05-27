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

describe('OnlyCat Adapter => isVersionLessThan()', () => {
    let adapter;

    beforeEach(() => {
        adapter = createAdapter({});
    });

    // invalid inputs
    it('should return false when version is undefined', () => {
        adapter.isVersionLessThan(undefined, '1.0.0').should.be.false;
    });

    it('should return false when version is null', () => {
        adapter.isVersionLessThan(null, '1.0.0').should.be.false;
    });

    it('should return false when version is unknown', () => {
        adapter.isVersionLessThan('unknown', '1.0.0').should.be.false;
    });

    it('should return false when version has less than 3 parts', () => {
        adapter.isVersionLessThan('1.0', '1.0.0').should.be.false;
    });

    it('should return false when lessThan is undefined', () => {
        adapter.isVersionLessThan('1.0.0', undefined).should.be.false;
    });

    it('should return false when lessThan is null', () => {
        adapter.isVersionLessThan('1.0.0', null).should.be.false;
    });

    it('should return false when lessThan is unknown', () => {
        adapter.isVersionLessThan('1.0.0', 'unknown').should.be.false;
    });

    it('should return false when lessThan has less than 3 parts', () => {
        adapter.isVersionLessThan('1.0.0', '2.0').should.be.false;
    });

    // equal versions
    it('should return false when versions are equal', () => {
        adapter.isVersionLessThan('1.2.3', '1.2.3').should.be.false;
    });

    // major version comparison
    it('should return true when major version is less', () => {
        adapter.isVersionLessThan('1.9.9', '2.0.0').should.be.true;
    });

    it('should return false when major version is greater', () => {
        adapter.isVersionLessThan('2.0.0', '1.9.9').should.be.false;
    });

    it('should handle double-digit major versions correctly', () => {
        adapter.isVersionLessThan('9.0.0', '10.0.0').should.be.true;
    });

    // minor version comparison
    it('should return true when minor version is less', () => {
        adapter.isVersionLessThan('1.1.9', '1.2.0').should.be.true;
    });

    it('should return false when minor version is greater', () => {
        adapter.isVersionLessThan('1.2.0', '1.1.9').should.be.false;
    });

    it('should handle double-digit minor versions correctly', () => {
        adapter.isVersionLessThan('1.9.0', '1.10.0').should.be.true;
    });

    // patch version comparison
    it('should return true when patch version is less', () => {
        adapter.isVersionLessThan('1.2.3', '1.2.4').should.be.true;
    });

    it('should return false when patch version is greater', () => {
        adapter.isVersionLessThan('1.2.4', '1.2.3').should.be.false;
    });

    it('should handle double-digit patch versions correctly', () => {
        adapter.isVersionLessThan('1.0.9', '1.0.10').should.be.true;
    });
});