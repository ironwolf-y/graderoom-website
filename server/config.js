// Deployment decisions, kept pure so they can be tested without starting a server.

/**
 * The port to listen on. PaaS hosts set PORT in upper case, .env files and the
 * upstream setup use port in lower case, so both are read.
 * @param {Object} env
 * @returns {number}
 */
exports.httpPort = function (env = process.env) {
    return parseInt(env.PORT || env.port);
};

/**
 * The address to listen on. Empty means every interface, which is what the
 * upstream server does. Set it to 127.0.0.1 when a tunnel in front of the box is
 * the only way in.
 * @param {Object} env
 * @returns {string}
 */
exports.listenHost = function (env = process.env) {
    return env.HOST || '';
};

/**
 * Where the session store lives. A hosted Redis has to be reachable by URL, so
 * REDIS_URL wins; without it the port-derived local default is used, which keeps
 * every existing local setup working unchanged.
 * @param {number} httpPort
 * @param {Object} env
 * @returns {string}
 */
exports.redisUrl = function (httpPort, env = process.env) {
    return env.REDIS_URL || `redis://127.0.0.1:${httpPort + 383}`;
};

/**
 * Whether this is the beta server. It used to be inferred from the port, which put
 * every host that assigns a port into beta mode, and beta mode needs a beta key to
 * sign up and uses a different database. BETA now says so explicitly; leaving it
 * unset keeps the old behaviour.
 * @param {number} httpPort
 * @param {Object} env
 * @returns {boolean}
 */
exports.isBetaServer = function (httpPort, env = process.env) {
    if (env.BETA !== undefined && env.BETA !== "") {
        return env.BETA === "true";
    }
    if (!httpPort || isNaN(httpPort)) {
        // There is no port to infer from, and beta is the surprising answer, so the
        // stable database is the one to act on
        return false;
    }
    return httpPort !== 5996;
};

/**
 * Load the .env file. dotenv does not overwrite variables that are already set, so a
 * real environment always wins over the file.
 */
exports.loadEnv = function () {
    require("dotenv").config();
};
