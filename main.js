'use strict';

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const got = require('got').default;
const Json2iob = require('json2iob');
const tough = require('tough-cookie');
const qs = require('qs');
const { HttpsCookieAgent } = require('http-cookie-agent/http');

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
    this.cookieJar = new tough.CookieJar();
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
    const tokenState = await this.getStateAsync('auth.token');
    if (tokenState && tokenState.val) {
      this.session = JSON.parse(tokenState.val);
      this.log.info('Old Session found');
      const cookieState = await this.getStateAsync('cookie');
      if (cookieState && cookieState.val) {
        this.log.debug('Load cookie');
        this.cookieJar = tough.CookieJar.fromJSON(cookieState.val);
        // const cookieString =  'JWT_FGP=' + this.cookieJar.store.idx['connect.garmin.com']['/']['JWT_FGP'].value + '; Domain=.connect.garmin.com; Path=/;Secure';
        // this.cookieJar.setCookieSync(cookieString, 'https://connect.garmin.com');
        await this.sleep(200);
      }
    } else if (this.config.token) {
      this.log.info('Use settings token');
      this.session = JSON.parse(this.config.token);
      //set JWT_FGP cookie from config.fgp value on domain .connect.garmin.com and path /
      const cookieString = 'JWT_FGP=' + this.config.fgp.trim() + '; Domain=.connect.garmin.com; Path=/;Secure';
      this.cookieJar.setCookieSync(cookieString, 'https://connect.garmin.com');
    }
    if (!this.session || !this.session.access_token) {
      this.log.warn('No token found. Please enter token in the settings');
      return;
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
  async login() {
    const form = await this.requestClient({
      method: 'get',
      url: 'https://sso.garmin.com/sso/signin?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&webhost=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&source=https%3A%2F%2Fconnect.garmin.com%2Fsignin%2F&redirectAfterAccountLoginUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&redirectAfterAccountCreationUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&gauthHost=https%3A%2F%2Fsso.garmin.com%2Fsso&locale=en_GB&id=gauth-widget&cssUrl=https%3A%2F%2Fconnect.garmin.com%2Fgauth-custom-v1.2-min.css&privacyStatementUrl=https%3A%2F%2Fwww.garmin.com%2Fen-GB%2Fprivacy%2Fconnect%2F&clientId=GarminConnect&rememberMeShown=true&rememberMeChecked=false&createAccountShown=true&openCreateAccount=false&displayNameShown=false&consumeServiceTicket=false&initialFocus=true&embedWidget=false&socialEnabled=false&generateExtraServiceTicket=true&generateTwoExtraServiceTickets=true&generateNoServiceTicket=false&globalOptInShown=true&globalOptInChecked=false&mobile=false&connectLegalTerms=true&showTermsOfUse=false&showPrivacyPolicy=false&showConnectLegalAge=false&locationPromptShown=true&showPassword=true&useCustomHeader=false&mfaRequired=false&performMFACheck=false&rememberMyBrowserShown=true&rememberMyBrowserChecked=false',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
        'accept-language': 'en-GB,en;q=0.9',
        referer: 'https://connect.garmin.com/',
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return this.extractHidden(res.data);
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    let url =
      'https://sso.garmin.com/sso/signin?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&webhost=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&source=https%3A%2F%2Fconnect.garmin.com%2Fsignin&redirectAfterAccountLoginUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&redirectAfterAccountCreationUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&gauthHost=https%3A%2F%2Fsso.garmin.com%2Fsso&locale=en_GB&id=gauth-widget&cssUrl=https%3A%2F%2Fconnect.garmin.com%2Fgauth-custom-v1.2-min.css&privacyStatementUrl=https%3A%2F%2Fwww.garmin.com%2Fen-GB%2Fprivacy%2Fconnect%2F&clientId=GarminConnect&rememberMeShown=true&rememberMeChecked=false&createAccountShown=true&openCreateAccount=false&displayNameShown=false&consumeServiceTicket=false&initialFocus=true&embedWidget=false&socialEnabled=false&generateExtraServiceTicket=true&generateTwoExtraServiceTickets=true&generateNoServiceTicket=false&globalOptInShown=true&globalOptInChecked=false&mobile=false&connectLegalTerms=true&showTermsOfUse=false&showPrivacyPolicy=false&showConnectLegalAge=false&locationPromptShown=true&showPassword=true&useCustomHeader=false&mfaRequired=false&performMFACheck=false&rememberMyBrowserShown=true&rememberMyBrowserChecked=false';
    let data = {
      username: this.config.username,
      password: this.config.password,
      _csrf: form._csrf,
      embed: 'false',
    };
    if (this.config.mfa) {
      url =
        'https://sso.garmin.com/sso/verifyMFA/loginEnterMfaCode?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&webhost=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&source=https%3A%2F%2Fconnect.garmin.com%2Fsignin%2F&redirectAfterAccountLoginUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&redirectAfterAccountCreationUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&gauthHost=https%3A%2F%2Fsso.garmin.com%2Fsso&locale=en_GB&id=gauth-widget&cssUrl=https%3A%2F%2Fconnect.garmin.com%2Fgauth-custom-v1.2-min.css&privacyStatementUrl=https%3A%2F%2Fwww.garmin.com%2Fen-GB%2Fprivacy%2Fconnect%2F&clientId=GarminConnect&rememberMeShown=true&rememberMeChecked=false&createAccountShown=true&openCreateAccount=false&displayNameShown=false&consumeServiceTicket=false&initialFocus=true&embedWidget=false&socialEnabled=false&generateExtraServiceTicket=true&generateTwoExtraServiceTickets=true&generateNoServiceTicket=false&globalOptInShown=true&globalOptInChecked=false&mobile=false&connectLegalTerms=true&showTermsOfUse=false&showPrivacyPolicy=false&showConnectLegalAge=false&locationPromptShown=true&showPassword=true&useCustomHeader=false&mfaRequired=false&performMFACheck=false&rememberMyBrowserShown=true&rememberMyBrowserChecked=false';
      data = {
        'mfa-code': this.config.mfa,
        embed: 'false',
        fromPage: 'setupEnterMfaCode',
      };
    }

    const ticket = await got
      .post(url, {
        http2: true,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'content-type': 'application/x-www-form-urlencoded',
          'accept-language': 'de-de',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15',
        },

        body: qs.stringify(data),
      })
      .then((res) => {
        res.data = res.body;
        this.log.debug(JSON.stringify(res.data));
        const body = res.data;
        try {
          if (res.data.includes('window.VIEWER_USERPREFERENCES')) {
            this.userpreferences = JSON.parse(res.data.split('window.VIEWER_USERPREFERENCES = ')[1].split(';\n')[0]);
            this.social_media = JSON.parse(res.data.split('window.VIEWER_SOCIAL_PROFILE = ')[1].split(';\n')[0]);
            this.json2iob.parse('userpreferences', this.userpreferences);
            this.json2iob.parse('social_profile', this.social_media);
          }
        } catch (error) {
          this.log.error(error);
        }
        if (res.data.includes('submit-mfa-verification-code-form')) {
          this.log.info('MFA required. Please enter MFA in the settings');
          return;
        }
        return body.split('ticket=')[1].split('";')[0];
      })
      .catch((error) => {
        if (error.response && error.response.status === 403) {
          this.log.error('Please update node to version 18 or higher');
          return;
        }
        this.log.error('Failed ticket please check username and password');
        this.log.error(error);
        error.response && this.log.debug(JSON.stringify(error.response.data));
        if (this.config.mfa) {
          const adapterConfig = 'system.adapter.' + this.name + '.' + this.instance;
          this.getForeignObject(adapterConfig, (error, obj) => {
            if (obj && obj.native && obj.native.mfa) {
              obj.native.mfa = '';
              this.setForeignObject(adapterConfig, obj);
            }
          });
        }
      });

    if (!ticket) {
      return;
    }
    const result = await this.requestClient({
      method: 'get',
      url: 'https://connect.garmin.com/modern/?ticket=' + ticket,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
        'accept-language': 'en-GB,en;q=0.9',
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));

        this.setState('cookie', JSON.stringify(this.cookieJar.toJSON()), true);
        try {
          if (res.data.includes('window.VIEWER_USERPREFERENCES')) {
            this.userpreferences = JSON.parse(res.data.split('window.VIEWER_USERPREFERENCES = ')[1].split(';\n')[0]);
            this.social_media = JSON.parse(res.data.split('window.VIEWER_SOCIAL_PROFILE = ')[1].split(';\n')[0]);
            this.json2iob.parse('userpreferences', this.userpreferences);
            this.json2iob.parse('social_profile', this.social_media);
          }
        } catch (error) {
          this.log.error(error);
        }
        this.setState('info.connection', true, true);
        await this.requestClient({
          method: 'post',
          url: 'https://connect.garmin.com/modern/di-oauth/exchange',
          headers: {
            accept: 'application/json, text/plain, */*',
            'x-app-ver': '4.60.2.0',
            NK: 'NT',
          },
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            this.session = res.data;
          })
          .catch((error) => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
        return true;
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });

    return result;
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
    this.log.debug('Refresh token');
    //set this.config.fgp as cookie JWT_FGP
    if (this.config.fgp) {
      const cookieString = 'JWT_FGP=' + this.config.fgp.trim() + '; Domain=.connect.garmin.com; Path=/;Secure';
      this.cookieJar.setCookieSync(cookieString, 'https://connect.garmin.com');
    }

    // await this.login();
    // await this.requestClient({
    //   method: 'get',
    //   maxBodyLength: Infinity,
    //   url: 'https://sso.garmin.com/sso/login?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2Factivities&webhost=https%3A%2F%2Fconnect.garmin.com&gateway=true&generateExtraServiceTicket=true&generateTwoExtraServiceTickets=true&clientId=CAS_CLIENT_DEFAULT',
    //   headers: {
    //     Host: 'sso.garmin.com',
    //     'Sec-Fetch-Site': 'same-site',
    //     'Sec-Fetch-Mode': 'navigate',
    //     Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    //     'User-Agent':
    //       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    //     'Accept-Language': 'en-GB,en;q=0.9',
    //     Referer: 'https://sso.garmin.com/',
    //     'Sec-Fetch-Dest': 'document',
    //   },
    // }).catch((error) => {
    //   this.log.warn('Failed refresh cookies');
    //   this.log.warn(error);
    //   error.response && this.log.warn(JSON.stringify(error.response.data));
    // });
    this.log.debug(JSON.stringify(this.cookieJar.toJSON()));
    this.log.debug(this.session.access_token);
    this.log.debug(this.session.refresh_token);
    await got
      .post('https://connect.garmin.com/services/auth/token/refresh', {
        cookieJar: this.cookieJar,
        http2: true,
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          baggage:
            'sentry-environment=prod,sentry-release=connect%405.9.30,sentry-public_key=f0377f25d5534ad589ab3a9634f25e71,sentry-trace_id=72fb803ded6b453a886dec69c8ecb129,sentry-sample_rate=1,sentry-sampled=true',
          Accept: 'application/json, text/plain, */*',
          'X-app-ver': '5.9.0.31a',
          'Accept-Language': 'en-GB,en;q=0.9',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          NK: 'NT',
        },
        json: {
          refresh_token: this.session.refresh_token,
        },
      })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.body));
        // this.session = res.data;

        const resJson = JSON.parse(res.body);
        if (resJson.access_token) {
          this.session = resJson;
          try {
            //extract JWT_FGP cookie from response header
            this.config.fgp = res.headers['set-cookie'][0].split('JWT_FGP=')[1].split(';')[0];
          } catch (error) {
            this.log.error('Failed to extract JWT_FGP cookie');
          }
        }

        this.setState('info.connection', true, true);

        await this.setState('auth.token', res.body, true);
        //set cookie state
        await this.setState('cookie', JSON.stringify(this.cookieJar.toJSON()), true);
      })
      .catch((error) => {
        //check for error status 500
        //log cookie request header
        this.log.debug(error.request.options.headers);
        if (error.response && error.response.statusCode === 500) {
          this.log.error('FGP missmatch. Please logout and login in garmin and update FGP in the settings');
          this.log.debug(error);
          this.setState('info.connection', false, true);
          this.setState('auth.token', '', true);
          this.session = {};
          return;
        }
        this.log.error('Failed refresh token');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
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
