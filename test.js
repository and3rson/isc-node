const chai = require('chai');
const expect = chai.expect;
const isc = require('.');

chai.should();

const createClient = () => {
    return isc.createClient({
        exchange: 'isc-node-test',
        invokeTimeout: 1000,
        services: {
            dummy: {
                ping: () => {
                    return 'pong';
                }
            },
            calculator: {
                add: (a, b) => {
                    return {value: a + b};
                },
                div: (a, b) => {
                    return new Promise((resolve, reject) => {
                        if (b != 0) {
                            resolve({value: a / b});
                        } else {
                            reject('Division by zero!');
                        }
                    });
                },
                slowMethod: () => {
                    return new Promise((resolve, reject) => {
                        setTimeout(() => resolve(42), 1500);
                    });
                }
            }
        }
    });
};

describe('Client tests', () => {
    const client = createClient();
    it('should send & receive simple invocation requests', () => {
        return client.invoke('dummy', 'ping').then((result) => {
            expect(result).to.equal('pong');
        });
    });
    it('should handle arguments', () => {
        return client.invoke('calculator', 'add', [1, 2]).then((result) => {
            expect(result.value).to.equal(3);
        });
    });
    it('should handle errors', () => {
        return client.invoke('calculator', 'div', [1, 0]).catch((result) => {
            expect(result).to.equal('Division by zero!');
        });
    });
    it('should handle timeouts', () => {
        return client.invoke('calculator', 'slowMethod').catch((result) => {
            expect(result).to.be.an('error');
            expect(result.message).to.equal('ISC request timed out after 1000ms.');
        });
    });
});
