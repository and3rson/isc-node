module.exports = {
    "env": {
        "browser": true,
        "commonjs": true,
        "es6": true,
        "node": true
    },
    "extends": "eslint:recommended",
    "parserOptions": {
        "sourceType": "module"
    },
    "rules": {
        "indent": [
            "error",
            4
        ],
        "linebreak-style": [
            "error",
            "unix"
        ],
        "quotes": [
            "error",
            "single"
        ],
        "semi": [
            "error",
            "always"
        ],
        "prefer-const": [
            "error"
        ],
        "no-const-assign": [
            "error"
        ],
        "no-var": [
            "error"
        ],
        "no-console": 0,
        "no-cond-assign": 0,
    }
};
