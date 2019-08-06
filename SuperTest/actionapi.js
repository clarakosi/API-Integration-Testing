const { assert } = require('chai');
const supertest = require('supertest');
const uniqid = require('uniqid');
const config = require('./config.json');

const methods = {

  /**
   * Constructs an HTTP request to the action API and returns the
   * corresponding supertest Test object, which behaves like a
   * superagent Request. It can be used like a Promise that resolves
   * to a Response.
   *
   * The request has not been sent when this method returns,
   * and can still be modified like a superagent request.
   * Call end() or then(), use use await to send the request.
   *
   * @param actionName
   * @param {Object} params
   * @param post
   *
   * @returns Test
   */
  async request(actionName, params, post = false) {
    // FIXME: it would be nice if we could resolve/await any promises in params

    const defaultParams = {
      action: actionName,
      format: 'json',
    };

    let req;
    if (post) {
      req = this.post('')
        .type('form')
        .send({ ...defaultParams, ...params });
    } else {
      req = this.get('')
        .query({ ...defaultParams, ...params });
    }

    return req;
  },

  /**
   * Executes an HTTP request to the action API and returns the parsed
   * response body. Will fail if the reponse contains an error code.
   *
   * @param actionName
   * @param {Object} params
   * @param post
   * @returns {Promise<Object>}
   */
  async action(actionName, params, post = false) {
    const response = await this.request(actionName, params, post);

    assert.equal(response.status, 200);
    assert.exists(response.body);

    if (response.body.error) {
      assert.fail(`Action "${actionName}" returned error code "${response.body.error.code}": ${response.body.error.info}!`);
    }

    return response.body;
  },

  /**
   * Executes an HTTP request to the action API and returns the error
   * stanza of the response body. Will fail if there is no error stanza.
   * This is intended as an easy way to test for expected errors.
   *
   * @param actionName
   * @param {Object} params
   * @param post
   * @returns {Promise<Object>}
   */
  async actionError(actionName, params, post = false) {
    const response = await this.request(actionName, params, post);

    assert.equal(response.status, 200);
    assert.exists(response.body);
    assert.exists(response.body.error);
    return response.body.error;
  },

  /**
   * Loads the given tokens. Any cached tokens are reset.
   *
   * @param {string[]} ttypes
   * @returns {Promise<Object>}
   */
  async loadTokens(ttypes) {
    const result = await this.action(
      'query',
      { meta: 'tokens', types: ttypes.join('|') },
    );

    this.tokens = result.query.tokens;
    return result.query.tokens;
  },

  /**
   * Returns the given token. If the token is not cached, it is requested
   * and then cached.
   *
   * @param {string} ttype
   * @returns {Promise<string>}
   */
  async token(ttype = 'csrf') {
    if (ttype in this.tokens) {
      return this.tokens[ttype];
    }

    // TODO: skip tokens we already have!
    const newTokens = (await this.action(
      'query',
      { meta: 'tokens', type: ttype },
    )).query.tokens;

    this.tokens = { ...this.tokens, ...newTokens };

    const tname = `${ttype}token`;
    assert.exists(this.tokens[tname]);
    return this.tokens[tname];
  },

  /**
   * Logs this agent in as the given user.
   *
   * @param {string} username
   * @param {string} password
   * @returns {Promise<Object>}
   */
  async login(username, password) {
    const result = await this.action(
      'login',
      {
        lgname: username,
        lgpassword: password,
        lgtoken: await this.token('login'),
      },
      'POST',
    );
    assert.equal(result.login.result, 'Success',
      `Login for "${username}": ${result.login.reason}`);
    return result.login;
  },

  /**
   * Performs an edit on a page.
   *
   * @param {string} pageTitle
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async edit(pageTitle, params) {
    const editParams = {
      title: pageTitle,
      text: 'Lorem Ipsum',
      comment: 'testing',
    };

    editParams.token = params.token || await this.token('csrf');

    const result = await this.action('edit', { ...editParams, ...params }, 'POST');
    assert.equal(result.edit.result, 'Success');

    return result.edit;
  },

  /**
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async createAccount(params) {
    const defaults = {
      createtoken: params.token || await this.token('createaccount'),
      retype: params.retype || params.password,
      createreturnurl: config.base_uri,
    };

    const result = await this.action('createaccount', { ...defaults, ...params }, 'POST');
    assert.equal(result.createaccount.status, 'PASS');
    return result.createaccount;
  },

  /**
   * @param {string} userName
   * @param {string[]} groups
   * @returns {Promise<Object>}
   */
  async addGroups(userName, groups) {
    const gprops = {
      user: userName,
      add: groups.join('|'),
      token: await this.token('userrights'),
    };

    const result = await this.action('userrights', gprops, 'POST');
    assert.isOk(result.userrights.added);
    return result.userrights;
  },
};

/**
 * Constructs a new agent for making HTTP requests to the action API.
 * The agent acts like a browser session and has its own cookie yar.
 *
 * If a user name and a password is given, a login for this user is performed,
 * and the corresponding server session is associated with this agent.
 * This should only be used when instantiating fixtures.
 *
 * If no password is given, a new user account is created with a random
 * password and a random suffix appended to the user name. The new user is
 * then logged in. This should be used to construct a temporary unique
 * user account that can be modified and detroyed by tests.
 *
 * When used with no user name, the agent behaves like an "anonymous" user.
 * Note that all anonymous users share the same IP address, even though they
 * don't share a browser session (cookie jar). This means that are treated
 * as the same user in some respects, but not in others.
 *
 * @param {string|null} name
 * @param {string|null} passwd
 * @returns {Promise<TestAgent>}
 */
module.exports.agent = async (name = null, passwd = null) => {
  const instance = supertest.agent(config.base_uri);

  instance.tokens = {};

  // FIXME: is this the correct way?
  for (const m in methods) {
    instance[m] = methods[m].bind(instance);
  }

  if (name) {
    let uname = name;
    let upass = passwd;

    if (!upass) {
      uname = name + uniqid();
      upass = uniqid();

      const account = await instance.createAccount({ username: uname, password: upass });
      uname = account.username;
    }

    const login = await instance.login(uname, upass);
    instance.username = login.lgusername;
    instance.userid = login.lguserid;
  }

  return instance;
};

/**
 * Returns a unique title for use in tests.
 *
 * @param {string|null} namePrefix
 * @returns string
 */
module.exports.title = namePrefix => namePrefix + uniqid();
