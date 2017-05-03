const chai = require('chai');
const expect = chai.expect;
const client = require('.').createClient();

chai.should();

for(let i = 0; i < 100; i++) {
    client.invoke('proxy', 'get_info').then((response) => {
        console.log('Got response:', response);
    }).catch((e) => {
        console.error('Client error:', e);
    });
}
