'use strict';

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const crypto = require('crypto');
const OAuth = require('oauth-1.0a');
const axios = require('axios').default;
const Json2iob = require('json2iob');
const { CookieJar } = require('tough-cookie');

const { HttpsCookieAgent } = require('http-cookie-agent/http');

const UA_IOS = 'GCM-iOS-5.7.2.1';
const DOMAIN = 'garmin.com';

// Load your modules here, e.g.:
// const fs = require("fs");

class Garmin extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'garmin',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.deviceArray = [];
    this.json2iob = new Json2iob(this);
    this.allowlistExact = [];
    this.allowlistSearch = [];
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);

    this.session = {};
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }
    if (!this.config.username || !this.config.password) {
      this.log.error('Please set username and password in the instance settings');
      return;
    }

    // Parse allowlists from config
    if (this.config.allowlistExact && typeof this.config.allowlistExact === 'string') {
      this.allowlistExact = this.config.allowlistExact
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0);
      if (this.allowlistExact.length > 0) {
        this.log.info('Exact allowlist active: ' + this.allowlistExact.join(', '));
      }
    }
    if (this.config.allowlistSearch && typeof this.config.allowlistSearch === 'string') {
      this.allowlistSearch = this.config.allowlistSearch
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0);
      if (this.allowlistSearch.length > 0) {
        this.log.info('Search allowlist active: ' + this.allowlistSearch.join(', '));
      }
    }

    await this.extendObject('auth', {
      type: 'channel',
      common: {
        name: 'Auth',
      },
      native: {},
    });
    await this.extendObject('auth.token', {
      type: 'state',
      common: {
        name: 'Token',
        type: 'string',
        role: 'value',
        read: true,
        write: false,
      },
      native: {},
    });
    await this.extendObject('auth.mfaSession', {
      type: 'state',
      common: {
        name: 'MFA Session',
        type: 'string',
        role: 'value',
        read: true,
        write: false,
      },
      native: {},
    });
    const tokenState = await this.getStateAsync('auth.token');
    if (tokenState && tokenState.val && typeof tokenState.val === 'string') {
      this.session = JSON.parse(tokenState.val);
      this.log.info('Old Session found');
    }

    // If no session or no access token, perform full login
    if (!this.session || !this.session.access_token) {
      this.log.info('No token found, performing login...');
      const loginSuccess = await this.performFullLogin();
      if (!loginSuccess) {
        this.log.error('Login failed');
        return;
      }
    }
    await this.refreshToken();
    if (!this.session.access_token) {
      this.log.error('Failed to login');
      return;
    }
    await axios({
      method: 'GET',
      url: 'https://connect.garmin.com/userprofile-service/userprofile/userProfileBase',
      headers: {
        Authorization: 'Bearer ' + this.session.access_token,
        Accept: 'application/json, text/plain, */*',
        'DI-Backend': 'connectapi.garmin.com',
        'User-Agent': UA_IOS,
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.userpreferences = res.data;
      })
      .catch((error) => {
        this.log.error(error.message);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.subscribeStates('*');

    // this.log.info('Login to Garmin');
    // const result = await this.login();

    await this.getDeviceList();
    await this.updateDevices();
    this.updateInterval = setInterval(
      async () => {
        await this.updateDevices();
      },
      this.config.interval * 60 * 1000,
    );

    this.refreshTokenInterval = this.setInterval(
      async () => {
        await this.refreshToken();
      },
      13 * 60 * 1000 - 5234,
    );
  }
  async fetchOAuthConsumer() {
    return axios({
      method: 'GET',
      url: 'https://thegarth.s3.amazonaws.com/oauth_consumer.json',
      timeout: 10000,
    })
      .then((res) => {
        this.log.debug('Fetched OAuth consumer from S3');
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.log.debug('Failed to fetch OAuth consumer: ' + error.message);
        this.log.warn('Using fallback OAuth consumer credentials');
        return {
          consumer_key: 'fc3e99d2-118c-44b8-8ae3-03370dde24c0',
          consumer_secret: 'E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF',
        };
      });
  }

  createOAuthClient(consumerKey, consumerSecret) {
    return OAuth({
      consumer: { key: consumerKey, secret: consumerSecret },
      signature_method: 'HMAC-SHA1',
      hash_function(base_string, key) {
        return crypto.createHmac('sha1', key).update(base_string).digest('base64');
      },
    });
  }

  createClient(cookieJar) {
    return axios.create({
      withCredentials: true,
      httpsAgent: new HttpsCookieAgent({
        cookies: {
          jar: cookieJar,
        },
      }),
      maxRedirects: 5,
    });
  }

  async login() {
    this.log.info('Starting SSO login...');

    const SSO = `https://sso.${DOMAIN}/sso`;
    const SSO_EMBED = `${SSO}/embed`;
    const SSO_EMBED_PARAMS = {
      id: 'gauth-widget',
      embedWidget: 'true',
      gauthHost: SSO,
    };
    const SIGNIN_PARAMS = {
      id: 'gauth-widget',
      embedWidget: 'true',
      gauthHost: SSO_EMBED,
      service: SSO_EMBED,
      source: SSO_EMBED,
      redirectAfterAccountLoginUrl: SSO_EMBED,
      redirectAfterAccountCreationUrl: SSO_EMBED,
    };

    // Check if we have a saved MFA session to resume
    const mfaSessionState = await this.getStateAsync('auth.mfaSession');
    if (this.config.mfa && mfaSessionState && mfaSessionState.val && typeof mfaSessionState.val === 'string') {
      this.log.info('Resuming MFA session...');
      try {
        const mfaSession = JSON.parse(mfaSessionState.val);
        // Restore cookies from serialized CookieJar
        const cookieJar = CookieJar.fromJSON(mfaSession.cookieJar);
        const client = this.createClient(cookieJar);

        // Submit MFA code with saved session
        const mfaHtml = await client({
          method: 'POST',
          url: `${SSO}/verifyMFA/loginEnterMfaCode`,
          params: SIGNIN_PARAMS,
          headers: {
            'User-Agent': UA_IOS,
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: `${SSO}/signin?${new URLSearchParams(SIGNIN_PARAMS)}`,
          },
          data: {
            'mfa-code': this.config.mfa,
            embed: 'true',
            _csrf: mfaSession.csrf,
            fromPage: 'setupEnterMfaCode',
          },
        })
          .then((res) => {
            this.log.debug('MFA resume response: ' + res.status);
            this.log.debug(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.log.error('MFA resume failed: ' + error.message);
            return null;
          });

        if (!mfaHtml) {
          throw new Error('MFA resume request failed');
        }
        const mfaTitleMatch = mfaHtml.match(/<title>(.+?)<\/title>/);
        const mfaTitle = mfaTitleMatch ? mfaTitleMatch[1] : '';
        this.log.debug('MFA Response title: ' + mfaTitle);

        // Clear saved MFA session
        await this.setState('auth.mfaSession', '', true);

        if (mfaTitle === 'Success') {
          const ticketMatch = mfaHtml.match(/embed\?ticket=([A-Za-z0-9-]+)/);
          if (ticketMatch) {
            this.log.info('MFA verification successful');
            this.log.debug('Ticket: ' + ticketMatch[1]);
            return ticketMatch[1];
          }
        }
        this.log.warn('Saved MFA session expired, starting fresh login...');
      } catch (e) {
        this.log.warn('Failed to resume MFA session: ' + e);
        await this.setState('auth.mfaSession', '', true);
      }
    }

    // Create client for fresh login
    const cookieJar = new CookieJar();
    const client = this.createClient(cookieJar);

    // Step 1: Set cookies
    this.log.debug('Setting SSO cookies...');
    await client({
      method: 'GET',
      url: `${SSO}/embed`,
      params: SSO_EMBED_PARAMS,
      headers: { 'User-Agent': UA_IOS },
    })
      .then((res) => {
        this.log.debug('SSO cookies response: ' + res.status);
        this.log.debug(JSON.stringify(res.data));
      })
      .catch((error) => {
        this.log.error('SSO cookies failed: ' + error.message);
      });

    // Step 2: Get CSRF token
    this.log.debug('Getting CSRF token...');
    const signinPageHtml = await client({
      method: 'GET',
      url: `${SSO}/signin`,
      params: SIGNIN_PARAMS,
      headers: {
        'User-Agent': UA_IOS,
        Referer: `${SSO}/embed?${new URLSearchParams(SSO_EMBED_PARAMS)}`,
      },
    })
      .then((res) => {
        this.log.debug('CSRF response: ' + res.status);
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.log.error('CSRF request failed: ' + error.message);
        return null;
      });

    if (!signinPageHtml) {
      return null;
    }

    const csrfMatch = signinPageHtml.match(/name="_csrf"\s+value="(.+?)"/);
    if (!csrfMatch) {
      this.log.error('CSRF token not found');
      this.log.debug('Response: ' + signinPageHtml.substring(0, 500));
      return null;
    }
    const csrfToken = csrfMatch[1];

    // Step 3: Submit login
    this.log.debug('Submitting login...');
    const loginHtml = await client({
      method: 'POST',
      url: `${SSO}/signin`,
      params: SIGNIN_PARAMS,
      headers: {
        'User-Agent': UA_IOS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${SSO}/signin?${new URLSearchParams(SIGNIN_PARAMS)}`,
      },
      data: {
        username: this.config.username,
        password: this.config.password,
        embed: 'true',
        _csrf: csrfToken,
      },
    })
      .then((res) => {
        this.log.debug('Login response: ' + res.status);
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.log.error('Login request failed: ' + error.message);
        return null;
      });

    if (!loginHtml) {
      return null;
    }
    const titleMatch = loginHtml.match(/<title>(.+?)<\/title>/);
    const title = titleMatch ? titleMatch[1] : '';
    this.log.debug('Response title: ' + title);

    // Handle MFA
    if (title.includes('MFA')) {
      const mfaCsrfMatch = loginHtml.match(/name="_csrf"\s+value="(.+?)"/);
      const mfaCsrf = mfaCsrfMatch ? mfaCsrfMatch[1] : csrfToken;

      if (!this.config.mfa) {
        // Save session for resuming after MFA code is entered
        this.log.info('MFA required. Saving session...');
        const mfaSession = {
          cookieJar: cookieJar.toJSON(),
          csrf: mfaCsrf,
          timestamp: Date.now(),
        };
        await this.setState('auth.mfaSession', JSON.stringify(mfaSession), true);
        this.log.info('Please enter MFA code in the settings. The session is saved for 5 minutes.');
        return null;
      }

      // MFA code is available, submit it
      this.log.info('MFA code found, submitting...');
      const mfaHtml = await client({
        method: 'POST',
        url: `${SSO}/verifyMFA/loginEnterMfaCode`,
        params: SIGNIN_PARAMS,
        headers: {
          'User-Agent': UA_IOS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${SSO}/signin?${new URLSearchParams(SIGNIN_PARAMS)}`,
        },
        data: {
          'mfa-code': this.config.mfa,
          embed: 'true',
          _csrf: mfaCsrf,
          fromPage: 'setupEnterMfaCode',
        },
      })
        .then((res) => {
          this.log.debug('MFA response: ' + res.status);
          this.log.debug(JSON.stringify(res.data));
          return res.data;
        })
        .catch((error) => {
          this.log.error('MFA request failed: ' + error.message);
          return null;
        });

      if (!mfaHtml) {
        return null;
      }
      const mfaTitleMatch = mfaHtml.match(/<title>(.+?)<\/title>/);
      const mfaTitle = mfaTitleMatch ? mfaTitleMatch[1] : '';
      this.log.debug('MFA Response title: ' + mfaTitle);

      if (mfaTitle !== 'Success') {
        this.log.error('MFA verification failed. Code may be expired or invalid.');
        return null;
      }

      const ticketMatch = mfaHtml.match(/embed\?ticket=([A-Za-z0-9-]+)/);
      if (ticketMatch) {
        this.log.info('MFA verification successful');
        this.log.debug('Ticket: ' + ticketMatch[1]);
        return ticketMatch[1];
      }
    }

    if (title !== 'Success') {
      this.log.error('Login failed. Check username and password.');
      this.log.debug('HTML: ' + loginHtml.substring(0, 500));
      return null;
    }

    // Extract ticket
    const ticketMatch = loginHtml.match(/embed\?ticket=([A-Za-z0-9-]+)/);
    if (!ticketMatch) {
      this.log.error('Ticket not found in response');
      return null;
    }

    this.log.info('SSO Login successful');
    this.log.debug('Ticket: ' + ticketMatch[1]);
    return ticketMatch[1];
  }

  async getOAuth1Token(ticket) {
    this.log.debug('Getting OAuth1 token...');

    const consumer = await this.fetchOAuthConsumer();
    this.oauth = this.createOAuthClient(consumer.consumer_key, consumer.consumer_secret);

    const loginUrl = `https://sso.${DOMAIN}/sso/embed`;
    const url = `https://connectapi.${DOMAIN}/oauth-service/oauth/preauthorized?ticket=${ticket}&login-url=${encodeURIComponent(loginUrl)}&accepts-mfa-tokens=true`;

    const request_data = { url, method: 'GET' };
    const authHeader = this.oauth.toHeader(this.oauth.authorize(request_data));

    return axios({
      method: 'GET',
      url: url,
      headers: {
        'User-Agent': UA_IOS,
        ...authHeader,
      },
    })
      .then((res) => {
        this.log.debug('OAuth1 Status: ' + res.status);
        this.log.debug(JSON.stringify(res.data));
        const params = new URLSearchParams(res.data);
        const oauth1Token = {
          oauth_token: params.get('oauth_token'),
          oauth_token_secret: params.get('oauth_token_secret'),
          mfa_token: params.get('mfa_token'),
        };
        this.log.debug('OAuth1 Token: ' + (oauth1Token.oauth_token ? 'OK' : 'MISSING'));
        return oauth1Token;
      })
      .catch((error) => {
        this.log.error('OAuth1 request failed: ' + (error.response?.status || '') + ' ' + error.message);
        return null;
      });
  }

  async exchangeOAuth2Token(oauth1Token) {
    this.log.debug('Exchanging for OAuth2 token...');
    this.log.debug('oauth1Token: ' + JSON.stringify(oauth1Token));

    if (!this.oauth) {
      this.log.error('OAuth client not initialized!');
      return null;
    }

    const url = `https://connectapi.${DOMAIN}/oauth-service/oauth/exchange/user/2.0`;

    // Body data - must be included in OAuth signature
    const bodyData = oauth1Token.mfa_token ? { mfa_token: oauth1Token.mfa_token } : {};

    const request_data = {
      url,
      method: 'POST',
      data: bodyData, // Include body in signature calculation
    };
    const token = {
      key: oauth1Token.oauth_token,
      secret: oauth1Token.oauth_token_secret,
    };
    const authHeader = this.oauth.toHeader(this.oauth.authorize(request_data, token));
    this.log.debug('authHeader: ' + JSON.stringify(authHeader));

    const body = oauth1Token.mfa_token ? `mfa_token=${oauth1Token.mfa_token}` : '';
    this.log.debug('body: ' + body);

    return axios({
      method: 'POST',
      url: url,
      headers: {
        'User-Agent': UA_IOS,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...authHeader,
      },
      data: body,
    })
      .then((res) => {
        this.log.debug('OAuth2 Status: ' + res.status);
        this.log.debug(JSON.stringify(res.data));
        const oauth2Token = res.data;
        oauth2Token.expires_at = Math.floor(Date.now() / 1000) + oauth2Token.expires_in;
        oauth2Token.refresh_token_expires_at = Math.floor(Date.now() / 1000) + oauth2Token.refresh_token_expires_in;
        this.log.debug('OAuth2 Token: OK');
        return oauth2Token;
      })
      .catch((error) => {
        this.log.error('OAuth2 request failed: ' + (error.response?.status || '') + ' ' + error.message);
        if (error.response?.data) {
          this.log.error('OAuth2 error response: ' + JSON.stringify(error.response.data));
        }
        return null;
      });
  }

  async performFullLogin() {
    const ticket = await this.login();
    if (!ticket) {
      this.log.error('Login failed - no ticket');
      return false;
    }

    const oauth1Token = await this.getOAuth1Token(ticket);
    if (!oauth1Token) {
      this.log.error('OAuth1 token exchange failed');
      return false;
    }

    const oauth2Token = await this.exchangeOAuth2Token(oauth1Token);
    if (!oauth2Token) {
      this.log.error('OAuth2 token exchange failed');
      // Clear MFA session and token to force fresh login next time
      this.log.info('Clearing MFA session and token for fresh login...');
      await this.setState('auth.mfaSession', '', true);
      await this.setState('auth.token', '', true);
      return false;
    }

    // Store OAuth2 token - refresh_token is used for token refresh
    this.session = oauth2Token;
    await this.setState('auth.token', JSON.stringify(this.session), true);
    this.setState('info.connection', true, true);

    this.log.info('Full login successful');
    return true;
  }

  async getDeviceList() {
    await axios({
      method: 'GET',
      url: 'https://connect.garmin.com/device-service/deviceregistration/devices',
      headers: {
        Authorization: 'Bearer ' + this.session.access_token,
        'DI-Backend': 'connectapi.garmin.com',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': UA_IOS,
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data) {
          this.log.info(`Found ${res.data.length} devices`);
          await this.setObjectNotExistsAsync('devices', {
            type: 'channel',
            common: {
              name: 'Devices',
            },
            native: {},
          });

          for (const device of res.data) {
            this.log.debug(JSON.stringify(device));
            const id = device.unitId.toString();

            this.deviceArray.push(device);
            const name = device.productDisplayName;

            await this.setObjectNotExistsAsync('devices.' + id, {
              type: 'device',
              common: {
                name: name,
              },
              native: {},
            });
            // await this.setObjectNotExistsAsync(id + ".remote", {
            //   type: "channel",
            //   common: {
            //     name: "Remote Controls",
            //   },
            //   native: {},
            // });

            // const remoteArray = [{ command: "Refresh", name: "True = Refresh" }];
            // remoteArray.forEach((remote) => {
            //   this.setObjectNotExists(id + ".remote." + remote.command, {
            //     type: "state",
            //     common: {
            //       name: remote.name || "",
            //       type: remote.type || "boolean",
            //       role: remote.role || "boolean",
            //       def: remote.def || false,
            //       write: true,
            //       read: true,
            //     },
            //     native: {},
            //   });
            // });
            this.json2iob.parse('devices.' + id + '.general', device, { forceIndex: true });
          }
        }
      })
      .catch((error) => {
        this.log.error(error.message);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async updateDevices() {
    this.userpreferences;
    const date = new Date().toISOString().split('T')[0];
    const dateMinus10 = new Date(new Date().setDate(new Date().getDate() - 6)).toISOString().split('T')[0];
    const statusArray = [
      {
        path: 'usersummary',
        url:
          'https://connect.garmin.com/usersummary-service/usersummary/daily/' +
          this.userpreferences.displayName +
          '?calendarDate=' +
          date,
        desc: 'User Summary Daily',
      },
      {
        path: 'maxmet',
        url: 'https://connect.garmin.com/metrics-service/metrics/maxmet/daily/' + date + '/' + date,
        desc: 'Max Metrics Daily',
      },
      {
        path: 'hydration',
        url: 'https://connect.garmin.com/usersummary-service/usersummary/hydration/daily/' + date,
        desc: 'Hydration Daily',
      },
      {
        path: 'personalrecords',
        url: 'https://connect.garmin.com/personalrecord-service/personalrecord/prs/' + this.userpreferences.displayName,
        desc: 'Personal Records',
      },
      {
        path: 'adhocchallenge',
        url: 'https://connect.garmin.com/adhocchallenge-service/adHocChallenge/historical',
        desc: 'Adhoc Challenge',
      },
      {
        path: 'dailysleep',
        url:
          'https://connect.garmin.com/wellness-service/wellness/dailySleepData/' +
          this.userpreferences.displayName +
          '?date=' +
          date +
          '&nonSleepBufferMinutes=60',
        desc: 'Daily Sleep',
      },
      {
        path: 'dailystress',
        url: 'https://connect.garmin.com/wellness-service/wellness/dailyStress/' + date,
        desc: 'Daily Stress',
      },
      {
        path: 'heartrate',
        url:
          'https://connect.garmin.com/userstats-service/wellness/daily/' +
          this.userpreferences.displayName +
          '?fromDate=' +
          dateMinus10,
        desc: 'Resting Heartrate',
      },
      {
        path: 'trainingstatus',
        url: 'https://connect.garmin.com/metrics-service/metrics/trainingstatus/aggregated/' + date,
        desc: 'Training Status',
      },
      {
        path: 'activities',
        url: 'https://connect.garmin.com/activitylist-service/activities/search/activities?start=0&limit=10',
        desc: 'Activities',
      },
      {
        path: 'weight',
        url: 'https://connect.garmin.com/weight-service/weight/dateRange?startDate=' + dateMinus10 + '&endDate=' + date,
        desc: 'Weight',
      },
    ];

    for (const element of statusArray) {
      await axios({
        method: element.method || 'GET',
        url: element.url,
        headers: {
          Accept: 'application/json, text/plain, */*',
          Authorization: 'Bearer ' + this.session.access_token,
          'DI-Backend': 'connectapi.garmin.com',
          'User-Agent': UA_IOS,
        },
      })
        .then((res) => {
          this.log.debug(JSON.stringify(res.data));
          if (!res.data) {
            return;
          }
          // Check for empty arrays/objects before filtering
          if (Array.isArray(res.data) && res.data.length === 0) {
            this.log.debug('Empty array response for ' + element.path);
            return;
          }
          if (typeof res.data === 'object' && !Array.isArray(res.data) && Object.keys(res.data).length === 0) {
            this.log.debug('Empty object response for ' + element.path);
            return;
          }
          const filteredData = this.filterByAllowlist(res.data);
          if (filteredData === null) {
            this.log.debug('No data left after allowlist filter for ' + element.path);
            return;
          }
          // Also check if filtered data is empty
          if (Array.isArray(filteredData) && filteredData.length === 0) {
            this.log.debug('Empty array after filter for ' + element.path);
            return;
          }
          if (typeof filteredData === 'object' && !Array.isArray(filteredData) && Object.keys(filteredData).length === 0) {
            this.log.debug('Empty object after filter for ' + element.path);
            return;
          }
          this.json2iob.parse(element.path, filteredData, {
            forceIndex: true,
            write: true,
            preferedArrayName: null,
            channelName: element.desc,
          });
        })
        .catch((error) => {
          if (error.response && error.response.status === 401) {
            this.log.debug(JSON.stringify(error.response.data));
            this.log.info(element.path + ' received 401 error. Refreshing token in 60 seconds');
            this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
            this.refreshTokenTimeout = setTimeout(() => {
              this.refreshToken();
            }, 1000 * 60);
            return;
          }
          this.log.error(element.url);
          this.log.error(error.message);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }
  extractHidden(body) {
    const returnObject = {};
    const matches = body.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g);
    for (const match of matches) {
      if (match[2] != null) {
        returnObject[match[1]] = match[2];
      }
    }
    return returnObject;
  }
  async sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  filterByAllowlist(data, path = '') {
    // If both lists are empty, return all data
    if (this.allowlistExact.length === 0 && this.allowlistSearch.length === 0) {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item, index) => this.filterByAllowlist(item, `${path}[${index}]`)).filter((item) => item !== null);
    }

    if (data !== null && typeof data === 'object') {
      const filtered = {};
      for (const key of Object.keys(data)) {
        const fullPath = path ? `${path}.${key}` : key;
        const keyLower = key.toLowerCase();
        const fullPathLower = fullPath.toLowerCase();

        // Check exact match (by key or full path)
        const isExactMatch = this.allowlistExact.includes(keyLower) || this.allowlistExact.includes(fullPathLower);
        // Check search/partial match (by key or full path)
        const isSearchMatch = this.allowlistSearch.some((term) => keyLower.includes(term) || fullPathLower.includes(term));

        if (isExactMatch || isSearchMatch) {
          filtered[key] = data[key];
        } else if (typeof data[key] === 'object' && data[key] !== null) {
          const nestedFiltered = this.filterByAllowlist(data[key], fullPath);
          if (nestedFiltered !== null && Object.keys(nestedFiltered).length > 0) {
            filtered[key] = nestedFiltered;
          }
        }
      }
      return Object.keys(filtered).length > 0 ? filtered : null;
    }

    return data;
  }
  async refreshToken() {
    this.log.debug('Refreshing OAuth2 token...');

    // Check if we have a refresh token
    if (!this.session || !this.session.refresh_token) {
      this.log.warn('No refresh token available, performing full login');
      await this.performFullLogin();
      return;
    }

    const url = `https://connectapi.${DOMAIN}/di-oauth2-service/oauth/token`;

    const newToken = await axios({
      method: 'POST',
      url: url,
      headers: {
        'User-Agent': UA_IOS,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: {
        grant_type: 'refresh_token',
        client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI',
        refresh_token: this.session.refresh_token,
      },
    })
      .then((res) => {
        this.log.debug('Refresh Status: ' + res.status);
        this.log.debug(JSON.stringify(res.data));
        const token = res.data;
        token.expires_at = Math.floor(Date.now() / 1000) + token.expires_in;
        token.refresh_token_expires_at = Math.floor(Date.now() / 1000) + token.refresh_token_expires_in;
        this.log.debug('Token refreshed successfully');
        return token;
      })
      .catch((error) => {
        this.log.warn('Token refresh failed: ' + (error.response?.status || '') + ' ' + error.message);
        return null;
      });

    if (!newToken) {
      this.log.info('Performing full login...');
      await this.performFullLogin();
      return;
    }

    this.session = newToken;
    await this.setState('auth.token', JSON.stringify(this.session), true);
    this.setState('info.connection', true, true);
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  async onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      // Clear MFA code from settings after successful login
      if (this.config.mfa) {
        const adapterSettings = await this.getForeignObjectAsync('system.adapter.' + this.namespace);
        if (adapterSettings && adapterSettings.native) {
          adapterSettings.native.mfa = '';
          await this.setForeignObjectAsync('system.adapter.' + this.namespace, adapterSettings);
        }
      }
      callback();
    } catch (e) {
      this.log.error(e);
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        const deviceId = id.split('.')[2];
        const command = id.split('.')[5];

        if (id.split('.')[4] === 'Refresh') {
          this.updateDevices();
          return;
        }
        // TODO: Implement device command handling
        this.log.debug(`Command ${command} for device ${deviceId}: ${state.val}`);
      }
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Garmin(options);
} else {
  // otherwise start the instance directly
  new Garmin();
}
