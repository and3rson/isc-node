const chai = require('chai');
const expect = chai.expect;
const client = require('.').createClient();

chai.should();

const send = () => {
    return client.invoke('proxy', 'get_info').then((response) => {
        console.log('Got response:', response);
    }).catch((e) => {
        console.error('Client error:', e);
    });
};

// Promise.all(Array.from(new Array(10)).map(() => send()));

send();
