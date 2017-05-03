const uuid = require('uuid');
// const amqp = require('amqp');
const amqplib = require('amqplib');
const EventEmitter = require('events');
const winston = require('winston-color');

// TODO:
// Fanout
// Codecs


class Client extends EventEmitter {
    constructor(options) {
        super();

        options = options || {};
        options.exchange = options.exchange || 'isc';
        options.url = options.reconnect || 'amqp://guest:guest@127.0.0.1:5672';
        options.reconnect = options.reconnect || true;
        options.invokeTimeout = options.invokeTimeout || 20000;
        options.services = options.services || {};
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

        // this.conn = null;
        // this.exchange = null;
        // this.queue = null;
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
                this._responseQueueName = 'isc-node-response-' + uuid.v4();

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

                return channel.assertExchange(this.options.exchange, 'direct', {durable: false, autoDelete: false})
                    .then(ok => {
                        this.logger.debug('Declared exchange %s', ok.exchange);
                        return this.createQueue(channel, this._responseQueueName, true, false, false, this.onResponse.bind(this));
                        // return channel.assertQueue(this._responseQueueName, {exclusive: true});
                    })
                    // .then(() => {
                    //     channel.consume(this._responseQueueName, this.onMessage, {noAck: false});
                    // })
                    .then(() => {
                        return Promise.all(
                            Object.keys(this.options.services).map(serviceName => {
                                // let serviceValue = this.options.services(serviceName);
                                return this.createQueue(channel, [this.options.exchange, 'service', serviceName].join('_'), false, false, false, this.onRequest.bind(this));
                            })
                        );
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
        // this.conn = amqp.createConnection({
        //     url: this.options.url,
        //     reconnect: true
        // }, {
        //     defaultExchangeName: this.options.exchange
        // });
        // this.conn.on('error', (e) => {
        //     winston.error('Connection error: %s', e.message);
        // });
        // this.conn.on('close', (e) => {
        //     winston.warn('Disconnected');
        //     this.isReady = false;
        // });
        // this.conn.on('ready', this.onConnectionReady.bind(this));
    }

    createQueue(channel, name, exclusive, durable, noAck, onConsume) {
        return channel.assertQueue(name, {exclusive: exclusive, durable: durable})
            .then(qok => {
                this.logger.debug('Declared queue %s', qok.queue);
                return channel.bindQueue(qok.queue, this.options.exchange, qok.queue);
            })
            .then(bok => {
                this.logger.debug('Bound queue %s to exchange %s', name, this.options.exchange);
                return channel.consume(bok.queue, onConsume, {noAck: noAck});
            })
        ;
    }

    // onConnectionReady() {
    //     winston.info('Connection ready');

    //     this.exchange = this.conn.exchange(
    //         this.options.exchange,
    //         {
    //             type: 'direct',
    //             durable: false,
    //             autoDelete: false
    //         },
    //         this.onExchangeReady.bind(this)
    //     );
    // }

    // onExchangeReady() {
    //     winston.info('Exchange ready');

    //     this._responseQueueName = 'isc-node-response-' + uuid.v4();

    //     this.queue = this.conn.queue(
    //         this._responseQueueName,
    //         {
    //             exclusive: true
    //         },
    //         this.onQueueReady.bind(this)
    //     );
    // }

    // onQueueReady() {
    //     winston.info('Queue ready, name = %s', this._responseQueueName);
    //     this.queue.bind(
    //         this.options.exchange,
    //         this._responseQueueName,
    //         this.onQueueBound.bind(this)
    //     );
    // }

    // onQueueBound() {
    //     winston.info('Queue bound');
    //     this.queue.subscribe(this.onMessage.bind(this));
    //     this.isReady = true;
    //     this.emit('ready');
    // }

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
        // message.fields.exchange;
        // message.properties.replyTo;
        // message.properties.replyTo;
        // message.properties.contentType;

        const serviceName = message.fields.routingKey.substr(
            message.fields.exchange.length + infix.length
        );

        const service = this.options.services[serviceName];
        if (!service) {
            this.logger.warn('Warning: got call to unknown service - %s', serviceName);
            return;
        }

        // new Promise((resolve, reject));

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
        // console.log('Request body:', body);
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
        // console.log(message);
        // console.log(headers);
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

            this.logger.info('Invoking %s.%s(*%s, **%s)', service, method, JSON.stringify(args), JSON.stringify(kwargs));

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
            // console.log(result);
            if (!result) {
                this.logger.error('Failed to publish message, will retry later: publish returned "false".');
                setTimeout(
                    () => this.invoke(service, method, args, kwargs, correlationId, future),
                    0
                );
            }
        }

        return promise;

        // TODO: Retry if publishing failed
    }

    deregisterFuture(correlationId) {
        const future = this.futures[correlationId];
        clearTimeout(future.timeout);
        delete this.futures[correlationId];
        future.timeout = 0;
    }
}

exports.Client = Client;
exports.createClient = (options) => {
    const client = new Client(options);
    client.start();
    return client;
};
