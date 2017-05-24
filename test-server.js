require('.').createClient({
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
