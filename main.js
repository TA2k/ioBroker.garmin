"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
const got = require("got").default;
const Json2iob = require("./lib/json2iob");
const tough = require("tough-cookie");
const qs = require("qs");
const { HttpsCookieAgent } = require("http-cookie-agent/http");

// Load your modules here, e.g.:
// const fs = require("fs");

class Garmin extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: "garmin",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
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
    this.setState("info.connection", false, true);
    if (this.config.interval < 0.5) {
      this.log.info("Set interval to minimum 0.5");
      this.config.interval = 0.5;
    }
    if (!this.config.username || !this.config.password) {
      this.log.error("Please set username and password in the instance settings");
      return;
    }
    const cookieState = await this.getStateAsync("cookie");
    if (cookieState && cookieState.val) {
      this.cookieJar = tough.CookieJar.fromJSON(cookieState.val);
    }

    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
    this.subscribeStates("*");

    this.log.info("Login to Garmin");
    const result = await this.login();
    if (result) {
      await this.getDeviceList();
      await this.updateDevices();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, this.config.interval * 60 * 1000);
    }
    this.refreshTokenInterval = setInterval(() => {
      this.refreshToken();
    }, (this.session.expires_in || 3600) * 1000);
  }
  async login() {
    const form = await this.requestClient({
      method: "get",
      url: "https://sso.garmin.com/sso/signin?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&webhost=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&source=https%3A%2F%2Fconnect.garmin.com%2Fsignin%2F&redirectAfterAccountLoginUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&redirectAfterAccountCreationUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&gauthHost=https%3A%2F%2Fsso.garmin.com%2Fsso&locale=en_GB&id=gauth-widget&cssUrl=https%3A%2F%2Fconnect.garmin.com%2Fgauth-custom-v1.2-min.css&privacyStatementUrl=https%3A%2F%2Fwww.garmin.com%2Fen-GB%2Fprivacy%2Fconnect%2F&clientId=GarminConnect&rememberMeShown=true&rememberMeChecked=false&createAccountShown=true&openCreateAccount=false&displayNameShown=false&consumeServiceTicket=false&initialFocus=true&embedWidget=false&socialEnabled=false&generateExtraServiceTicket=true&generateTwoExtraServiceTickets=true&generateNoServiceTicket=false&globalOptInShown=true&globalOptInChecked=false&mobile=false&connectLegalTerms=true&showTermsOfUse=false&showPrivacyPolicy=false&showConnectLegalAge=false&locationPromptShown=true&showPassword=true&useCustomHeader=false&mfaRequired=false&performMFACheck=false&rememberMyBrowserShown=true&rememberMyBrowserChecked=false",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
        "accept-language": "en-GB,en;q=0.9",
        referer: "https://connect.garmin.com/",
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
      "https://sso.garmin.com/sso/signin?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&webhost=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&source=https%3A%2F%2Fconnect.garmin.com%2Fsignin&redirectAfterAccountLoginUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&redirectAfterAccountCreationUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&gauthHost=https%3A%2F%2Fsso.garmin.com%2Fsso&locale=en_GB&id=gauth-widget&cssUrl=https%3A%2F%2Fconnect.garmin.com%2Fgauth-custom-v1.2-min.css&privacyStatementUrl=https%3A%2F%2Fwww.garmin.com%2Fen-GB%2Fprivacy%2Fconnect%2F&clientId=GarminConnect&rememberMeShown=true&rememberMeChecked=false&createAccountShown=true&openCreateAccount=false&displayNameShown=false&consumeServiceTicket=false&initialFocus=true&embedWidget=false&socialEnabled=false&generateExtraServiceTicket=true&generateTwoExtraServiceTickets=true&generateNoServiceTicket=false&globalOptInShown=true&globalOptInChecked=false&mobile=false&connectLegalTerms=true&showTermsOfUse=false&showPrivacyPolicy=false&showConnectLegalAge=false&locationPromptShown=true&showPassword=true&useCustomHeader=false&mfaRequired=false&performMFACheck=false&rememberMyBrowserShown=true&rememberMyBrowserChecked=false";
    let data = {
      username: this.config.username,
      password: this.config.password,
      _csrf: form._csrf,
      embed: "false",
      rememberme: "on",
    };
    if (this.config.mfa) {
      url =
        "https://sso.garmin.com/sso/verifyMFA/loginEnterMfaCode?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&webhost=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&source=https%3A%2F%2Fconnect.garmin.com%2Fsignin%2F&redirectAfterAccountLoginUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&redirectAfterAccountCreationUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&gauthHost=https%3A%2F%2Fsso.garmin.com%2Fsso&locale=en_GB&id=gauth-widget&cssUrl=https%3A%2F%2Fconnect.garmin.com%2Fgauth-custom-v1.2-min.css&privacyStatementUrl=https%3A%2F%2Fwww.garmin.com%2Fen-GB%2Fprivacy%2Fconnect%2F&clientId=GarminConnect&rememberMeShown=true&rememberMeChecked=false&createAccountShown=true&openCreateAccount=false&displayNameShown=false&consumeServiceTicket=false&initialFocus=true&embedWidget=false&socialEnabled=false&generateExtraServiceTicket=true&generateTwoExtraServiceTickets=true&generateNoServiceTicket=false&globalOptInShown=true&globalOptInChecked=false&mobile=false&connectLegalTerms=true&showTermsOfUse=false&showPrivacyPolicy=false&showConnectLegalAge=false&locationPromptShown=true&showPassword=true&useCustomHeader=false&mfaRequired=false&performMFACheck=false&rememberMyBrowserShown=true&rememberMyBrowserChecked=false";
      data = {
        "mfa-code": this.config.mfa,
        embed: "false",
        fromPage: "setupEnterMfaCode",
      };
    }

    const ticket = await got
      .post(url, {
        http2: true,
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "content-type": "application/x-www-form-urlencoded",
          "accept-language": "de-de",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15",
        },

        body: qs.stringify(data),
      })
      .then((res) => {
        res.data = res.body;
        this.log.debug(JSON.stringify(res.data));
        const body = res.data;
        try {
          if (res.data.includes("window.VIEWER_USERPREFERENCES")) {
            this.userpreferences = JSON.parse(res.data.split("window.VIEWER_USERPREFERENCES = ")[1].split(";\n")[0]);
            this.social_media = JSON.parse(res.data.split("window.VIEWER_SOCIAL_PROFILE = ")[1].split(";\n")[0]);
            this.json2iob.parse("userpreferences", this.userpreferences);
            this.json2iob.parse("social_profile", this.social_media);
          }
        } catch (error) {
          this.log.error(error);
        }
        if (res.data.includes("submit-mfa-verification-code-form")) {
          this.log.info("MFA required. Please enter MFA in the settings");
          return;
        }
        return body.split("ticket=")[1].split('";')[0];
      })
      .catch((error) => {
        if (error.response && error.response.status === 403) {
          this.log.error("Please update node to version 18 or higher");
          return;
        }
        this.log.error("Failed ticket please check username and password");
        this.log.error(error);
        error.response && this.log.debug(JSON.stringify(error.response.data));
        if (this.config.mfa) {
          const adapterConfig = "system.adapter." + this.name + "." + this.instance;
          this.getForeignObject(adapterConfig, (error, obj) => {
            if (obj && obj.native && obj.native.mfa) {
              obj.native.mfa = "";
              this.setForeignObject(adapterConfig, obj);
            }
          });
        }
      });

    if (!ticket) {
      return;
    }
    const result = await this.requestClient({
      method: "get",
      url: "https://connect.garmin.com/modern/?ticket=" + ticket,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
        "accept-language": "en-GB,en;q=0.9",
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));

        this.setState("cookie", JSON.stringify(this.cookieJar.toJSON()), true);
        try {
          if (res.data.includes("window.VIEWER_USERPREFERENCES")) {
            this.userpreferences = JSON.parse(res.data.split("window.VIEWER_USERPREFERENCES = ")[1].split(";\n")[0]);
            this.social_media = JSON.parse(res.data.split("window.VIEWER_SOCIAL_PROFILE = ")[1].split(";\n")[0]);
            this.json2iob.parse("userpreferences", this.userpreferences);
            this.json2iob.parse("social_profile", this.social_media);
          }
        } catch (error) {
          this.log.error(error);
        }
        this.setState("info.connection", true, true);
        await this.requestClient({
          method: "post",
          url: "https://connect.garmin.com/modern/di-oauth/exchange",
          headers: {
            accept: "application/json, text/plain, */*",
            "x-app-ver": "4.60.2.0",
            NK: "NT",
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
    await this.requestClient({
      method: "get",
      url: "https://connect.garmin.com/modern/proxy/device-service/deviceregistration/devices",
      headers: {
        NK: "NT",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data) {
          this.log.info(`Found ${res.data.length} devices`);
          await this.setObjectNotExistsAsync("devices", {
            type: "channel",
            common: {
              name: "Devices",
            },
            native: {},
          });

          for (const device of res.data) {
            this.log.debug(JSON.stringify(device));
            const id = device.unitId.toString();

            this.deviceArray.push(device);
            const name = device.productDisplayName;

            await this.setObjectNotExistsAsync("devices." + id, {
              type: "device",
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
            this.json2iob.parse("devices." + id + ".general", device, { forceIndex: true });
          }
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async updateDevices() {
    const date = new Date().toISOString().split("T")[0];
    const dateMinus10 = new Date(new Date().setDate(new Date().getDate() - 6)).toISOString().split("T")[0];
    const statusArray = [
      {
        path: "usersummary",
        url:
          "https://connect.garmin.com/modern/proxy/usersummary-service/usersummary/daily/" +
          this.userpreferences.displayName +
          "?calendarDate=" +
          date,
        desc: "User Summary Daily",
      },
      {
        path: "maxmet",
        url: "https://connect.garmin.com/modern/proxy/metrics-service/metrics/maxmet/daily/" + date + "/" + date,
        desc: "Max Metrics Daily",
      },
      {
        path: "hydration",
        url: "https://connect.garmin.com/modern/proxy/usersummary-service/usersummary/hydration/daily/" + date,
        desc: "Hydration Daily",
      },

      {
        path: "dailysleep",
        url:
          "https://connect.garmin.com/modern/proxy/wellness-service/wellness/dailySleepData/" +
          this.userpreferences.displayName +
          "?date=" +
          date +
          "&nonSleepBufferMinutes=60",
        desc: "Daily Sleep",
      },
      {
        path: "dailystress",
        url: "https://connect.garmin.com/modern/proxy/wellness-service/wellness/dailyStress/" + date,
        desc: "Daily Stress",
      },
      {
        path: "heartrate",
        url:
          "https://connect.garmin.com/modern/proxy/userstats-service/wellness/daily/" +
          this.userpreferences.displayName +
          "?fromDate=" +
          dateMinus10,
        desc: "Resting Heartrate",
      },
      {
        path: "trainingstatus",
        url: "https://connect.garmin.com/modern/proxy/metrics-service/metrics/trainingstatus/aggregated/" + date,
        desc: "Training Status",
      },
      {
        path: "activities",
        url: "https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities?start=0&limit=10",
        desc: "Activities",
      },
      {
        path: "weight",
        url:
          "https://connect.garmin.com/modern/proxy/weight-service/weight/dateRange?startDate=" +
          dateMinus10 +
          "&endDate=" +
          date,
        desc: "Weight",
      },
    ];

    if (this.config.adhoc) {
      statusArray.push({
        path: "adhocchallenge",
        url: "https://connect.garmin.com/modern/proxy/adhocchallenge-service/adHocChallenge/historical",
        desc: "Adhoc Challenge",
      });
      statusArray.push({
        path: "personalrecords",
        url:
          "https://connect.garmin.com/modern/proxy/personalrecord-service/personalrecord/prs/" +
          this.userpreferences.displayName,
        desc: "Personal Records",
      });
    }
    for (const element of statusArray) {
      // const url = element.url.replace("$id", id);

      await this.requestClient({
        method: element.method || "get",
        url: element.url,
        headers: {
          NK: "NT",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-GB,en;q=0.9",
        },
      })
        .then(async (res) => {
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
            if (error.response.status === 401) {
              error.response && this.log.debug(JSON.stringify(error.response.data));
              this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
              this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
              this.refreshTokenTimeout = setTimeout(() => {
                this.refreshToken();
              }, 1000 * 60);

              return;
            }
          }
          this.log.error(element.url);
          this.log.error(error);
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
  async refreshToken() {
    this.log.debug("Refresh token");

    await this.login();
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState("info.connection", false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
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
        const deviceId = id.split(".")[2];
        const command = id.split(".")[5];

        if (id.split(".")[4] === "Refresh") {
          this.updateDevices();
          return;
        }
        const data = {
          body: {},
          header: {
            command: "setAttributes",
            said: deviceId,
          },
        };
        data.body[command] = state.val;
        await this.requestClient({
          method: "post",
          url: "",
        })
          .then((res) => {
            this.log.info(JSON.stringify(res.data));
          })
          .catch(async (error) => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
        this.refreshTimeout = setTimeout(async () => {
          this.log.info("Update devices");
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
