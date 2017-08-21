const uuid = require('uuid');
// const amqp = require('amqp');
const amqplib = require('amqplib');
const EventEmitter = require('events');
const winston = require('winston-color');

// TODO:
// Fanout
// Codecs
// Timers

class Client extends EventEmitter {
    constructor(options) {
        super();

        options = options || {};
        options.exchange = options.exchange || 'isc';
        options.fanoutExchange = options.fanoutExchange || `${options.exchange}_fanout`;
        options.url = options.url || 'amqp://guest:guest@127.0.0.1:5672';
        options.reconnect = options.reconnect || true;
        options.invokeTimeout = options.invokeTimeout || 20000;
        options.services = options.services || {};
        options.listeners = options.listeners || {};
        if (options.logger) {
            this.logger = options.logger;
        } else {
            this.logger = winston;
            winston.level = options.debug_level || 'info';
        }

        this.options = options;
        this.isReady = false;
        this.isStopped = false;
        this.futures = {};

        this.channel = null;
    }

    start() {
        amqplib.connect(this.options.url)
            .then((conn) => {
                this.logger.debug('Connected to AMQP server');
                return conn.createChannel();
            })
            .then((channel) => {
                this.logger.debug('Created channel');
                this.channel = channel;
                this._responseQueueName = this.options.exchange + '-node-response-' + uuid.v4();
                this._fanoutQueueName = this.options.exchange + '-node-fanout-' + uuid.v4();

                channel.on('error', error => {
                    this.logger.info('Error on channel: %s', error);
                });
                channel.on('close', () => {
                    this.isReady = false;
                    if (this.options.reconnect) {
                        this.logger.info('Connection closed, will try to reconnect in 3 seconds.');
                        setTimeout(this.start.bind(this), 3000);
                    } else {
                        this.logger.info('Connection closed, not reconnecting.');
                    }
                });

                return channel.assertExchange(this.options.exchange, 'direct', {
                    durable: false,
                    autoDelete: false
                })
                    .then(ok => {
                        this.logger.debug('Declared exchange %s', ok.exchange);
                        return channel.assertExchange(this.options.fanoutExchange, 'fanout', {});
                    })
                    .then(ok => {
                        this.logger.debug('Declared fanout exchange %s', ok.exchange);
                        return this.createQueue(
                            channel,
                            this._fanoutQueueName,
                            this.options.fanoutExchange,
                            true,
                            false,
                            true,
                            this.onNotification.bind(this),
                            true
                        );
                    })
                    .then(ok => {
                        this.logger.debug('Declared fanout queue');
                        return this.createQueue(
                            channel,
                            this._responseQueueName,
                            this.options.exchange,
                            true,
                            false,
                            true,
                            this.onResponse.bind(this),
                            true
                        );
                    })
                    .then(() => {
                        let sequence = Promise.resolve();
                        Object.keys(this.options.services).forEach(serviceName => {
                            sequence = sequence.then(() => {
                                return this.createQueue(
                                    channel,
                                    [this.options.exchange, 'service', serviceName].join('_'),
                                    this.options.exchange,
                                    false,
                                    false,
                                    false,
                                    this.onRequest.bind(this),
                                    true
                                );
                            });
                        });
                        return sequence;
                    })
                ;
            })
            .then(() => {
                this.logger.info('Ready');
                this.isReady = true;
                this.emit('ready');
            })
            .catch(error => {
                this.logger.error('Client error: %s', error);
                this.isReady = false;
                this.channel.emit('close');
            })
        ;
    }

    createQueue(channel, name, exchange, exclusive, durable, noAck, onConsume, autoDelete) {
        return channel.assertQueue(name, {exclusive: exclusive, durable: durable, autoDelete: autoDelete})
            .then(qok => {
                this.logger.debug('Declared queue %s', qok.queue);
                return channel.bindQueue(qok.queue, exchange, qok.queue);
            })
            .then(bok => {
                this.logger.debug('Bound queue %s to exchange %s', name, exchange);
                return channel.consume(bok.queue, onConsume, {noAck: noAck});
            })
        ;
    }

    break() {
        this.conn.disconnect();
        this.isReady = false;
    }

    stop() {
        this.conn.disconnect();
        this.isStopped = true;
    }

    onRequest(message) {
        this.logger.debug('Got invocation ...%s', message.properties.correlationId.substr(-4));
        const infix = '_service_';

        const serviceName = message.fields.routingKey.substr(
            message.fields.exchange.length + infix.length
        );

        const service = this.options.services[serviceName];
        if (!service) {
            this.logger.warn('Warning: got call to unknown service - %s', serviceName);
            return;
        }

        const body = JSON.parse(message.content);
        if (body.length != 3) {
            this.logger.error('Error: got malformed request - "%s"', body);
        }
        const methodName = body[0];
        const methodArgs = body[1];
        const methodKWArgs = body[2];
        if (Object.keys(methodKWArgs).length) {
            this.logger.error('Error: NodeJS cannot handle "kwargs". Please pass only "args".');
            return;
        }
        const method = service[methodName];
        if (!method) {
            this.logger.error('Error: No such method: "%s"."%s"', serviceName, methodName);
            return;
        }

        this.channel.ack(message);

        Promise.resolve(method.apply(this, methodArgs)).then(result => {
            this.logger.debug('Publishing result for ...%s', message.properties.correlationId.substr(-4));
            this.channel.publish(
                this.options.exchange,
                message.properties.replyTo,
                new Buffer(JSON.stringify([null, result])),
                {
                    correlationId: message.properties.correlationId
                }
            );
        }).catch(e => {
            this.logger.warn('Publishing error for ...%s', message.properties.correlationId.substr(-4));
            this.channel.publish(
                this.options.exchange,
                message.properties.replyTo,
                new Buffer(JSON.stringify([e, null])),
                {
                    correlationId: message.properties.correlationId
                }
            );
        });
    }

    onResponse(message) {
        this.logger.debug('Got response for invocation ...%s', message.properties.correlationId.substr(-4));
        const future = this.futures[message.properties.correlationId];
        if (future) {
            this.logger.debug('Resolving future');

            const [error, result] = JSON.parse(message.content);
            if (error) {
                future.reject(error);
            } else {
                future.resolve(result);
            }
        } else {
            this.logger.warn('Warning: future with such correlationId not found!');
        }
    }

    onNotification(message) {
        const [event, data] = JSON.parse(message.content);
        if (this.options.listeners[event]) {
            this.logger.debug('Got notification ...%s, delegating to listener', message.properties.correlationId);
            this.options.listeners[event](data);
        } else {
            this.logger.debug('Got notification ...%s but no matching listener found, ignoring', message.properties.correlationId);
        }
    }

    invoke(service, method, args, kwargs, correlationId, future) {
        let promise = null;

        if (!future) {
            this.logger.debug('Attempting to invoke %s.%s', service, method);

            correlationId = uuid.v4();
            future = {
                resolve: null,
                reject: null,
                correlationId: correlationId,
                timeout: setTimeout(() => {
                    this.deregisterFuture(correlationId);
                    future.reject(new Error(`ISC request timed out after ${this.options.invokeTimeout}ms.`));
                }, this.options.invokeTimeout)
            };
            this.futures[correlationId] = future;

            promise = new Promise((resolve, reject) => {
                future.resolve = (data) => {
                    this.deregisterFuture(correlationId);
                    resolve(data);
                };
                future.reject = reject;
            });
        }

        if (!this.isReady) {
            this.once('ready', () => {
                this.invoke(service, method, args, kwargs, correlationId, future);
            });
        } else {
            args = args || [];
            kwargs = kwargs || {};

            this.logger.info('Publishing invocation %s.%s(*%s, **%s) with id ...%s', service, method, JSON.stringify(args), JSON.stringify(kwargs), correlationId.substr(-4));

            // TODO: Codecs

            const result = this.channel.publish(
                this.options.exchange,
                `${this.options.exchange}_service_${service}`,
                new Buffer(JSON.stringify([
                    method,
                    args,
                    kwargs
                ])),
                {
                    contentType: 'json',
                    replyTo: this._responseQueueName,
                    headers: {
                    },
                    correlationId: correlationId,
                    exchange: this.options.exchange
                }
            );

            if (!result) {
                this.logger.error('Failed to publish message, will retry later: publish returned "false".');
                setTimeout(
                    () => this.invoke(service, method, args, kwargs, correlationId, future),
                    0
                );
            }
        }

        return promise;
    }

    deregisterFuture(correlationId) {
        const future = this.futures[correlationId];
        clearTimeout(future.timeout);
        delete this.futures[correlationId];
        future.timeout = 0;
    }
}

const clientProxyHandler = {
    get: function(target, prop) {
        if(prop in target) {
            return target[prop];
        }
        return new Proxy([target, prop], serviceProxyHandler);
    }
};

const serviceProxyHandler = {
    get: function(target, prop) {
        const [client, service] = target;
        const fn = function() {};
        fn.meta = [client, service, prop];
        return new Proxy(fn, methodProxyHandler);
    }
};

const methodProxyHandler = {
    get: function() {
        console.log('methodProxyHandler.get not implemented yet');
    },
    apply: function(target, thisArg, argumentsList) {
        argumentsList = argumentsList.slice(0, 2);
        const [args, kwArgs] = argumentsList;
        if (typeof args !== undefined && !(args instanceof Array)) {
            throw new Error('Argument 1 of ISC method invocation must always be an Array.');
        }
        if (typeof kwArgs !== undefined && (kwArgs instanceof Array)) {
            throw new Error('Argument 2 of ISC method invocation must always be an Object.');
        }
        const [client, service, method] = target.meta;
        return client.invoke.apply(client, [service, method].concat(argumentsList));
    }
};

exports.Client = Client;
exports.createClient = (options) => {
    const client = new Client(options);
    client.start();
    const clientProxy = new Proxy(client, clientProxyHandler);
    return clientProxy;
};

