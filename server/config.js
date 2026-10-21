// Deployment decisions, kept pure so they can be tested without starting a server.

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
    return httpPort !== 5996;
};

/**
 * Load the .env file. dotenv does not overwrite variables that are already set, so a
 * real environment always wins over the file.
 */
exports.loadEnv = function () {
    require("dotenv").config();
};
