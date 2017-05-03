const chai = require('chai');
const expect = chai.expect;
const client = require('.').createClient({
    services: {
        dummy: {
            ping: () => {
                return 'pong';
            }
        },
        proxy: {
            get_info: () => {
                return new Promise((resolve, reject) => {
                    resolve({info: 'Some info'});
                });
            },
            dangerous_operation: () => {
                return new Promise((resolve, reject) => {
                    reject('OOPS!');
                });
            }
        }
    }
});

chai.should();

// describe('Client tests', () => {
//     it('should work', () => {
//         return client.invoke('mailer', 'ping').then((result) => {
//             expect(result).to.equal('pong');
//         });
//         // promises = [];
//         // for (var i = 0; i < 10; i++) {
//         //     promises.push(client.invoke('mailer', 'ping').then((result) => {
//         //         console.log('Result:', result)
//         //     }));
//         // }

//         // Promise.all(promises).then(() => {
//         //     client.stop();
//         // });
//     });
//     it('should handle timeouts', () => {
//         return client.invoke('unexisting-service', 'unexisting-method').then((resut) => {
//             console.log(result);
//         });
//     });
// });

// return client.invoke('mailer', 'ping').then((result) => {
//     console.log('Yes:', result);
//     // expect(result).to.equal('pong');
//     client.stop();

//     setTimeout(() => {
//         client.invoke('mailer', 'ping').then((result) => {
//             console.log('Yes 2:', result);
//         })
//     }, 1000);
// });

// setTimeout(() => {
//     client.stop();

//     setTimeout(() => {
//         client.stop();

//         setTimeout(() => {
//             client.invoke('mailer', 'ping').then((result) => {
//                 console.log('Result:', result);
//             })
//         }, 500);
//     }, 2000);
// }, 2000);

const send = (close) => {
    if (close) {
        client.break();
    }
    client.invoke('mailer', 'ping').then((response) => {
        console.log('Got response:', response);

        setTimeout(() => {
            send();
        }, 1000);
    }).catch((e) => {
        console.error('Client error:', e);
    });
};
send();
