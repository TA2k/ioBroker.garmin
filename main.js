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
const got = require('got').default;
const Json2iob = require('json2iob');
const { CookieJar, MemoryCookieStore } = require('tough-cookie');

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
    class CustomStore extends MemoryCookieStore {
      putCookie(cookie, cb) {
        // Remove expiration before saving
        cookie.expires = 'Infinity';
        cookie.maxAge = Infinity;
        super.putCookie(cookie, cb);
      }
    }

    this.cookieJar = new CookieJar(new CustomStore());

    this.requestClient = axios.create({
      withCredentials: true,
      httpsAgent: new HttpsCookieAgent({
        cookies: {
          jar: this.cookieJar,
        },
      }),
    });
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
    await this.extendObject('auth.oauth1Token', {
      type: 'state',
      common: {
        name: 'OAuth1 Token',
        type: 'string',
        role: 'value',
        read: true,
        write: false,
      },
      native: {},
    });
    const tokenState = await this.getStateAsync('auth.token');
    if (tokenState && tokenState.val) {
      this.session = JSON.parse(tokenState.val);
      this.log.info('Old Session found');
    }
    const oauth1State = await this.getStateAsync('auth.oauth1Token');
    if (oauth1State && oauth1State.val && typeof oauth1State.val === 'string') {
      this.oauth1Token = JSON.parse(oauth1State.val);
      this.log.info('OAuth1 token loaded');
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
    await got
      .get('https://connect.garmin.com/userprofile-service/userprofile/userProfileBase', {
        cookieJar: this.cookieJar,
        http2: true,
        headers: {
          Authorization: 'Bearer ' + this.session.access_token,
          Accept: 'application/json, text/plain, */*',
          'cache-control': 'no-cache',
          'di-backend': 'connectapi.garmin.com',
          nk: 'NT',
          pragma: 'no-cache',
          priority: 'u=1, i',
          referer: 'https://connect.garmin.com/modern/home',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          'x-app-ver': '5.9.0.31a',
          'x-lang': 'de-DE',
        },
      })
      .then((res) => {
        this.log.debug(res.body);
        this.userpreferences = JSON.parse(res.body);
      })
      .catch((error) => {
        this.log.error(error);
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
    try {
      const res = await fetch('https://thegarth.s3.amazonaws.com/oauth_consumer.json');
      const data = await res.json();
      this.log.debug('Fetched OAuth consumer from S3');
      return data;
    } catch (error) {
      this.log.debug(error);
      this.log.warn('Failed to fetch OAuth consumer, using fallback');
      return {
        consumer_key: 'fc3e99d2-118c-44b8-8ae3-03370dde24c0',
        consumer_secret: 'E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF',
      };
    }
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

  async fetchWithCookies(url, options = {}) {
    const cookieString = this.ssoCookieJar.getCookieString(url);
    const headers = {
      ...options.headers,
      ...(cookieString ? { Cookie: cookieString } : {}),
    };

    const res = await fetch(url, { ...options, headers, redirect: 'manual' });
    this.ssoCookieJar.setCookie(res.headers.get('set-cookie'), url);

    const setCookies = res.headers.getSetCookie?.() || [];
    for (const c of setCookies) {
      this.ssoCookieJar.setCookie(c, url);
    }

    return res;
  }

  async login() {
    this.log.info('Starting SSO login...');

    // Simple cookie jar for SSO
    this.ssoCookieJar = {
      cookies: {},
      setCookie(setCookieHeader, url) {
        if (!setCookieHeader) return;
        const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
        const domain = new URL(url).hostname;
        for (const header of headers) {
          const [cookiePart] = header.split(';');
          const [name, value] = cookiePart.split('=');
          if (name && value) {
            if (!this.cookies[domain]) this.cookies[domain] = {};
            this.cookies[domain][name.trim()] = value.trim();
          }
        }
      },
      getCookieString(url) {
        const domain = new URL(url).hostname;
        const parts = domain.split('.');
        const cookies = [];
        for (let i = 0; i < parts.length - 1; i++) {
          const d = parts.slice(i).join('.');
          if (this.cookies[d]) {
            for (const [name, value] of Object.entries(this.cookies[d])) {
              cookies.push(`${name}=${value}`);
            }
          }
        }
        return cookies.join('; ');
      },
    };

    const SSO = `https://sso.${DOMAIN}/sso`;
    const SSO_EMBED = `${SSO}/embed`;
    const SSO_EMBED_PARAMS = new URLSearchParams({
      id: 'gauth-widget',
      embedWidget: 'true',
      gauthHost: SSO,
    });
    const SIGNIN_PARAMS = new URLSearchParams({
      id: 'gauth-widget',
      embedWidget: 'true',
      gauthHost: SSO_EMBED,
      service: SSO_EMBED,
      source: SSO_EMBED,
      redirectAfterAccountLoginUrl: SSO_EMBED,
      redirectAfterAccountCreationUrl: SSO_EMBED,
    });

    // Step 1: Set cookies
    this.log.debug('Setting SSO cookies...');
    await this.fetchWithCookies(`${SSO}/embed?${SSO_EMBED_PARAMS}`, {
      headers: { 'User-Agent': UA_IOS },
    });

    // Step 2: Get CSRF token
    this.log.debug('Getting CSRF token...');
    const signinPageRes = await this.fetchWithCookies(`${SSO}/signin?${SIGNIN_PARAMS}`, {
      headers: {
        'User-Agent': UA_IOS,
        Referer: `${SSO}/embed?${SSO_EMBED_PARAMS}`,
      },
    });
    const signinPageHtml = await signinPageRes.text();

    const csrfMatch = signinPageHtml.match(/name="_csrf"\s+value="(.+?)"/);
    if (!csrfMatch) {
      this.log.error('CSRF token not found');
      this.log.debug('Response: ' + signinPageHtml.substring(0, 500));
      return null;
    }
    const csrfToken = csrfMatch[1];

    // Step 3: Submit login
    this.log.debug('Submitting login...');
    const loginRes = await this.fetchWithCookies(`${SSO}/signin?${SIGNIN_PARAMS}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA_IOS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${SSO}/signin?${SIGNIN_PARAMS}`,
      },
      body: new URLSearchParams({
        username: this.config.username,
        password: this.config.password,
        embed: 'true',
        _csrf: csrfToken,
      }),
    });

    const loginHtml = await loginRes.text();
    const titleMatch = loginHtml.match(/<title>(.+?)<\/title>/);
    const title = titleMatch ? titleMatch[1] : '';
    this.log.debug('Response title: ' + title);

    // Handle MFA
    if (title.includes('MFA')) {
      this.log.info('MFA required. Please enter MFA code in the settings');
      if (!this.config.mfa) {
        return null;
      }

      const mfaCsrfMatch = loginHtml.match(/name="_csrf"\s+value="(.+?)"/);
      const mfaCsrf = mfaCsrfMatch ? mfaCsrfMatch[1] : csrfToken;

      this.log.debug('Submitting MFA code...');
      const mfaRes = await this.fetchWithCookies(`${SSO}/verifyMFA/loginEnterMfaCode?${SIGNIN_PARAMS}`, {
        method: 'POST',
        headers: {
          'User-Agent': UA_IOS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${SSO}/signin?${SIGNIN_PARAMS}`,
        },
        body: new URLSearchParams({
          'mfa-code': this.config.mfa,
          embed: 'true',
          _csrf: mfaCsrf,
          fromPage: 'setupEnterMfaCode',
        }),
      });

      const mfaHtml = await mfaRes.text();
      const mfaTitleMatch = mfaHtml.match(/<title>(.+?)<\/title>/);
      const mfaTitle = mfaTitleMatch ? mfaTitleMatch[1] : '';
      this.log.debug('MFA Response title: ' + mfaTitle);

      if (mfaTitle !== 'Success') {
        this.log.error('MFA verification failed');
        // Clear MFA code from settings
        const adapterConfig = 'system.adapter.' + this.name + '.' + this.instance;
        this.getForeignObject(adapterConfig, (error, obj) => {
          if (obj && obj.native && obj.native.mfa) {
            obj.native.mfa = '';
            this.setForeignObject(adapterConfig, obj);
          }
        });
        return null;
      }

      const ticketMatch = mfaHtml.match(/embed\?ticket=([^"]+)"/);
      if (ticketMatch) {
        return ticketMatch[1];
      }
    }

    if (title !== 'Success') {
      this.log.error('Login failed. Check username and password.');
      this.log.debug('HTML: ' + loginHtml.substring(0, 500));
      return null;
    }

    // Extract ticket
    const ticketMatch = loginHtml.match(/embed\?ticket=([^"]+)"/);
    if (!ticketMatch) {
      this.log.error('Ticket not found in response');
      return null;
    }

    this.log.info('SSO Login successful');
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

    const res = await fetch(url, {
      headers: {
        'User-Agent': UA_IOS,
        ...authHeader,
      },
    });

    this.log.debug('OAuth1 Status: ' + res.status);

    if (res.ok) {
      const text = await res.text();
      const params = new URLSearchParams(text);
      const oauth1Token = {
        oauth_token: params.get('oauth_token'),
        oauth_token_secret: params.get('oauth_token_secret'),
        mfa_token: params.get('mfa_token'),
      };
      this.log.debug('OAuth1 Token: ' + (oauth1Token.oauth_token ? 'OK' : 'MISSING'));
      return oauth1Token;
    } else {
      const text = await res.text();
      this.log.error('OAuth1 Error: ' + text.substring(0, 300));
    }
    return null;
  }

  async exchangeOAuth2Token(oauth1Token) {
    this.log.debug('Exchanging for OAuth2 token...');

    const url = `https://connectapi.${DOMAIN}/oauth-service/oauth/exchange/user/2.0`;

    const request_data = { url, method: 'POST' };
    const token = {
      key: oauth1Token.oauth_token,
      secret: oauth1Token.oauth_token_secret,
    };
    const authHeader = this.oauth.toHeader(this.oauth.authorize(request_data, token));

    const body = oauth1Token.mfa_token ? `mfa_token=${oauth1Token.mfa_token}` : '';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA_IOS,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...authHeader,
      },
      body: body,
    });

    this.log.debug('OAuth2 Status: ' + res.status);

    if (res.ok) {
      const oauth2Token = await res.json();
      oauth2Token.expires_at = Math.floor(Date.now() / 1000) + oauth2Token.expires_in;
      oauth2Token.refresh_token_expires_at = Math.floor(Date.now() / 1000) + oauth2Token.refresh_token_expires_in;
      this.log.debug('OAuth2 Token: OK');
      return oauth2Token;
    } else {
      const text = await res.text();
      this.log.error('OAuth2 Error: ' + text.substring(0, 500));
    }
    return null;
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
      return false;
    }

    // Store both OAuth1 and OAuth2 tokens - OAuth1 is needed for refresh
    this.oauth1Token = oauth1Token;
    this.session = oauth2Token;
    await this.setState('auth.oauth1Token', JSON.stringify(oauth1Token), true);
    await this.setState('auth.token', JSON.stringify(this.session), true);
    this.setState('info.connection', true, true);

    this.log.info('Full login successful');
    return true;
  }

  async getDeviceList() {
    await got('https://connect.garmin.com/device-service/deviceregistration/devices', {
      method: 'get',

      headers: {
        Authorization: 'Bearer ' + this.session.access_token,
        'DI-Backend': 'connectapi.garmin.com',
        Accept: 'application/json, text/plain, */*',
        'X-app-ver': '5.9.0.31a',
        'Accept-Language': 'en-GB,en;q=0.9',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',

        NK: 'NT',
      },
      cookieJar: this.cookieJar,
      http2: true,
    })
      .then(async (res) => {
        res.data = JSON.parse(res.body);
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
        this.log.error(error);
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
      // const url = element.url.replace("$id", id);

      await got({
        cookieJar: this.cookieJar,
        method: element.method || 'get',
        url: element.url,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-app-ver': '5.9.0.31a',
          'Accept-Language': 'en-GB,en;q=0.9',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',

          Authorization: 'Bearer ' + this.session.access_token,
          'DI-Backend': 'connectapi.garmin.com',
        },
      })
        .then(async (res) => {
          res.data = JSON.parse(res.body);
          this.log.debug(JSON.stringify(res.data));
          if (!res.data) {
            return;
          }
          const data = res.data;

          const forceIndex = true;
          const preferedArrayName = null;

          this.json2iob.parse(element.path, data, {
            forceIndex: forceIndex,
            write: true,
            preferedArrayName: preferedArrayName,
            channelName: element.desc,
          });
          // await this.setObjectNotExistsAsync(element.path + ".json", {
          //   type: "state",
          //   common: {
          //     name: "Raw JSON",
          //     write: false,
          //     read: true,
          //     type: "string",
          //     role: "json",
          //   },
          //   native: {},
          // });
          // this.setState(element.path + ".json", JSON.stringify(data), true);
        })
        .catch((error) => {
          if (error.response) {
            if (error.response.statusCode === 401) {
              error.response && this.log.debug(JSON.stringify(error.response.body));
              this.log.info(element.path + ' received 401 error. Refreshing token in 60 seconds');
              this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
              this.refreshTokenTimeout = setTimeout(() => {
                this.refreshToken();
              }, 1000 * 60);

              return;
            }
          }
          this.log.error(element.url);
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.body));
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
  async refreshToken() {
    this.log.debug('Refreshing OAuth2 token...');

    // OAuth1 token is required for refresh (re-exchange approach like garth)
    if (!this.oauth1Token || !this.oauth1Token.oauth_token) {
      this.log.warn('No OAuth1 token available, performing full login');
      await this.performFullLogin();
      return;
    }

    try {
      const consumer = await this.fetchOAuthConsumer();
      if (!this.oauth) {
        this.oauth = this.createOAuthClient(consumer.consumer_key, consumer.consumer_secret);
      }

      // Re-exchange OAuth1 token for new OAuth2 token (like garth does)
      const oauth2Token = await this.exchangeOAuth2Token(this.oauth1Token);
      if (!oauth2Token) {
        this.log.warn('Token refresh via exchange failed, performing full login');
        await this.performFullLogin();
        return;
      }

      this.session = oauth2Token;
      await this.setState('auth.token', JSON.stringify(this.session), true);
      this.setState('info.connection', true, true);
      this.log.debug('Token refreshed successfully via OAuth1 exchange');
    } catch (error) {
      this.log.error('Refresh token error: ' + error);
      this.log.info('Performing full login...');
      await this.performFullLogin();
    }
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  async onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      if (this.config.token) {
        const adapterSettings = await this.getForeignObjectAsync('system.adapter.' + this.namespace);
        adapterSettings.native.token = null;
        adapterSettings.native.fgp = null;
        await this.setForeignObjectAsync('system.adapter.' + this.namespace, adapterSettings);
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
        const data = {
          body: {},
          header: {
            command: 'setAttributes',
            said: deviceId,
          },
        };
        data.body[command] = state.val;
        await this.requestClient({
          method: 'post',
          url: '',
        })
          .then((res) => {
            this.log.info(JSON.stringify(res.data));
          })
          .catch(async (error) => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
        this.refreshTimeout = setTimeout(async () => {
          this.log.info('Update devices');
          await this.updateDevices();
        }, 10 * 1000);
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
