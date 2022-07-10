const nodemailer = require("nodemailer");
const rp = require("request-promise-native");
const moment = require("moment");
const fs = require("fs");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
require("dotenv").config();

const ms = require("minestat");

// Change these to specify things to check
const WEBSITES = ["https://rachlinski.net", "https://blog.rachlinski.net"];
const MC_SERVERS = ["mc.rachlinski.net"];

const EMAIL_HEADER =
  "RachlinskiNET Downtime Detector Summary\nThis list only includes services that are down.\n----------------------------\n";

const DATE_FORMAT_STRING = "MM-DD-YYYY HH:mm:ss";

// Status object of last downtime
const STATUS_FILE = "./status.json";

const SEND_EMAIL = "chrisrachlinski@gmail.com";
const BCC = "";
const SERVER = "https://rachlinski.net";

// The time between follow up emails, in hours
const FOLLOW_UP_TIME = 10;

// Time in days between heartbeat interval to make sure account
// still works
const HEARTBEAT_INTERVAL = 7;

// Shamelessly stolen from
// https://dev.to/chandrapantachhetri/sending-emails-securely-using-node-js-nodemailer-smtp-gmail-and-oauth2-g3a
async function createTransporter() {
  const oauth2client = new OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );

  oauth2client.setCredentials({
    refresh_token: process.env.REFRESH_TOKEN,
  });

  const accessToken = await new Promise((resolve, reject) => {
    oauth2client.getAccessToken((err, token) => {
      if (err) {
        reject();
      }
      resolve(token);
    });
  });

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: process.env.EMAIL,
      accessToken,
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      refreshToken: process.env.REFRESH_TOKEN,
    },
  });

  return transporter;
}

function websiteStatus(ip) {
  return new Promise((resolve, reject) => {
    rp(ip)
      .then((res) => {
        resolve(res);
      })
      .catch((err) => {
        reject(err);
      });
  });
}

function minecraftStatus(ip, port) {
  return new Promise((resolve, reject) => {
    ms.init(ip, port, () => {
      if (ms.online) {
        resolve();
      } else {
        reject(ms.online);
      }
    });
  });
}

async function sendMail(subject, body) {
  let transporter = await createTransporter();

  return new Promise((resolve, reject) => {
    let mailOptions = {
      from: process.env.EMAIL,
      to: SEND_EMAIL,
      bcc: BCC,
      subject: subject,
      text: body,
    };

    transporter.sendMail(mailOptions, function (error, info) {
      if (error) {
        reject(error);
      } else {
        resolve(info);
      }
    });
  });
}

/**
 * @typedef status
 * @type {{url: String, type: String, unreachable: Boolean, status: Any, response: String, retrievedAt: Any, lastNotification: String}} status
 */

/**
 *
 * @param {status} curStatus
 * @param {Array<status>} oldStatuses
 * @return {boolean}
 */
function shouldSendEmail(curStatus, oldStatuses) {
  // Expected behavior is that we only send an email if a service that was
  // online before is down OR we have reached the nudge threshold.
  //if (moment().isAfter(lastDownMoment.add(FOLLOW_UP_TIME, "h")))

  if (curStatus.unreachable) {
    // If we are unreachable, we need to check if the same website
    // was previously not down if we want to email, or the last notification
    // was a long time ago
    let matchingOldStatuses = oldStatuses.filter((oldStatus) => {
      return oldStatus.url == curStatus.url;
    });

    // If there is no previous entry, then we should go ahead
    if (matchingOldStatuses.length == 0) {
      return true;
    } else {
      // We should only have one entry here if the websites are unique
      // which they are supposed to be
      let prevStatus = matchingOldStatuses[0];

      return (
        !prevStatus.unreachable ||
        moment().isAfter(
          moment(prevStatus.lastNotification, DATE_FORMAT_STRING).add(
            FOLLOW_UP_TIME,
            "h"
          )
        )
      );
    }
  } else {
    // If the service is reachable, dont send email
    return false;
  }
}

/**
 *
 * @param {status} status
 * @return {String}
 */
function asStatusString(status) {
  if (status.unreachable) {
    return `${status.type} at ${status.url} is unreachable as of ${status.retrievedAt}.\nStatus: ${status.status}\nResponse: ${status.response}\n`;
  } else {
    return `${status.type} at ${status.url} is reachable.\n`;
  }
}

/**
 *
 * @param {Array<status>} statuses
 * @return {{body: string, subject: string}}
 */
function createEmailString(statuses) {
  let body =
    EMAIL_HEADER +
    statuses.reduce((acc, cur) => {
      return acc + "\n\n" + asStatusString(cur);
    }, "");

  let subject = statuses.some((status) => status.unreachable)
    ? "[RachlinskiNET][SERVICE DOWN] A service was detected as down!"
    : "[RachlinskiNET] All services operational!";

  return { subject, body };
}

/**
 * Returns a string with the last update time, or if not found, a time
 * from a long time ago
 * @param {string} status
 * @param {Array<status>} oldStatuses
 * @return {string}
 */
function getLastNotification(status, oldStatuses) {
  let matchingOldStatuses = oldStatuses.filter((oldStatus) => {
    return oldStatus.url == status;
  });

  if (matchingOldStatuses.length == 0) {
    return moment(1).format(DATE_FORMAT_STRING);
  } else {
    return matchingOldStatuses[0].lastNotification;
  }
}

if (!fs.existsSync(STATUS_FILE)) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify([]));
}

if (process.argv[2] == "test") {
  console.log("Sending test mail");
  sendMail("[Test] Test of RachlinskiNET Downtime checker", "test test test");
} else {
  let currentTime = moment().format(DATE_FORMAT_STRING);

  /**
   * @type {Array<status>}
   */
  let latestStatus = [];
  let oldStatus = JSON.parse(fs.readFileSync(STATUS_FILE));

  console.log("Checking website status");

  let websitePromises = WEBSITES.map((site) => {
    console.log(`Checking website ${site}`);
    return websiteStatus(site)
      .then((res) => {
        let curStat = {
          url: site,
          type: "website",
          unreachable: false,
          status: res.statusCode,
          response: res.message,
          retrievedAt: currentTime,
          lastNotification: getLastNotification(site, oldStatus),
        };

        console.log(`Website ${site} was reachable`);
        latestStatus.push(curStat);
      })
      .catch((err) => {
        let curStat = {
          url: site,
          type: "website",
          unreachable: true,
          status: err.statusCode,
          response: err.message,
          retrievedAt: currentTime,
          lastNotification: getLastNotification(site, oldStatus),
        };

        // console.log("Body:" + err.message);
        // console.log("Status:" + err.statusCode);
        // console.log(err);

        console.log(`Website ${site} was unreachable`);
        latestStatus.push(curStat);
      });
  });

  console.log("Checking minecraft server status");
  let mcServerPromises = MC_SERVERS.map((srv) => {
    console.log(`Checking server ${srv}`);

    return minecraftStatus(srv, 25565)
      .then((res) => {
        let curStat = {
          url: srv,
          type: "minecraft server",
          unreachable: false,
          response: "",
          status: 200,
          retrievedAt: currentTime,
          lastNotification: getLastNotification(srv, oldStatus),
        };

        console.log(`Server ${srv} was reachable`);

        latestStatus.push(curStat);
      })
      .catch((err) => {
        let curStat = {
          type: "minecraft server",
          url: srv,
          unreachable: true,
          retrievedAt: currentTime,
          status: err,
          response: "",
          lastNotification: getLastNotification(srv, oldStatus),
        };

        console.log(`Server ${srv} was unreachable`);

        latestStatus.push(curStat);
      });
  });

  Promise.all(mcServerPromises.concat(websitePromises))
    .then((_) => {
      console.log("Done checking status");
      //      console.log(`Status: ${JSON.stringify(latestStatus)}`);

      /**
       * @type {Array<status>}
       */

      let toNotifyOn = latestStatus.filter((status) => {
        return shouldSendEmail(status, oldStatus);
      });

      if (toNotifyOn.length > 0) {
        console.log("Generating email subject and body");
        let { subject, body } = createEmailString(toNotifyOn);

        sendMail(subject, body);
        console.log("body:");
        console.log(body);
        console.log("subject:");
        console.log(subject);

        toNotifyOn.forEach((status) => {
          status.lastNotification = currentTime;
        });
      } else {
        console.log("No services found to notify on.");
      }

      fs.writeFileSync(STATUS_FILE, JSON.stringify(latestStatus));
    })
    .catch((err) => {
      console.log(err);
    });
}
