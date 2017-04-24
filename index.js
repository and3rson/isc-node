var uuid = require('uuid');
const amqp = require('amqp');
const EventEmitter = require('events');
const winston = require('winston-color');


class Client extends EventEmitter {
    constructor(options) {
        super();

        options = options || {};
        options.exchange = options.exchange || 'isc';
        options.url = options.reconnect || 'amqp://guest:guest@127.0.0.1:5672';
        options.reconnect = options.reconnect || true;
        options.invokeTimeout = options.invokeTimeout || 20000;
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

        this.conn = null;
        this.exchange = null;
        this.queue = null;
    }

    start() {
        this.conn = amqp.createConnection({
            url: this.options.url,
            reconnect: true
        }, {
            defaultExchangeName: this.options.exchange
        });
        this.conn.on('error', (e) => {
            winston.error('Connection error: %s', e.message);
        });
        this.conn.on('close', (e) => {
            winston.warn('Disconnected');
            this.isReady = false;
        });
        this.conn.on('ready', this.onConnectionReady.bind(this));
    }

    onConnectionReady() {
        winston.info('Connection ready');

        this.exchange = this.conn.exchange(
            this.options.exchange,
            {
                type: 'direct',
                durable: false,
                autoDelete: false
            },
            this.onExchangeReady.bind(this)
        );
    }

    onExchangeReady() {
        winston.info('Exchange ready');

        this._responseQueueName = 'isc-node-response-' + uuid.v4();

        this.queue = this.conn.queue(
            this._responseQueueName,
            {
                exclusive: true
            },
            this.onQueueReady.bind(this)
        );
    }

    onQueueReady() {
        winston.info('Queue ready, name = %s', this._responseQueueName);
        this.queue.bind(
            this.options.exchange,
            this._responseQueueName,
            this.onQueueBound.bind(this)
        );
    }

    onQueueBound() {
        winston.info('Queue bound');
        this.queue.subscribe(this.onMessage.bind(this));
        this.isReady = true;
        this.emit('ready');
    }

    break() {
        this.conn.disconnect();
        this.isReady = false;
    }

    stop() {
        this.conn.disconnect();
        this.isStopped = true;
    }

    onMessage(message, headers, deliveryInfo, messageObject) {
        const future = this.futures[messageObject.correlationId];
        if (future) {
            winston.debug('Resolving future');

            const [error, result] = JSON.parse(message.data);
            if (error) {
                future.reject(error);
            } else {
                future.resolve(result);
            }
        } else {
            winston.warn('Warning: future with such correlationId not found!');
        }
    }

    invoke(service, method, args, kwargs, correlationId, future) {
        let promise = null;

        if (!future) {
            winston.debug('Attempting to invoke %s.%s', service, method);

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

            winston.info('Invoking %s.%s(*%s, **%s)', service, method, JSON.stringify(args), JSON.stringify(kwargs));

            // TODO: Codecs

            this.exchange.publish(
                `${this.options.exchange}_service_${service}`,
                JSON.stringify([
                    method,
                    args,
                    kwargs
                ]),
                {
                    contentType: 'json',
                    replyTo: this._responseQueueName,
                    headers: {
                    },
                    correlationId: correlationId,
                    exchange: this.options.exchange
                }
            );
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
