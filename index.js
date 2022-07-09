const nodemailer = require("nodemailer");
const rp = require("request-promise-native");
const moment = require("moment");
const fs = require("fs");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
require("dotenv").config();

const DATE_FORMAT_STRING = "MM-DD-YYYY HH:mm:ss";

// Status object of last downtime
const STATUS_FILE = "./status.json";
var status = JSON.parse(fs.readFileSync(STATUS_FILE));

const SEND_EMAIL = "chrisrachlinski@gmail.com";
const BCC = "";
const SERVER = "https://rachlinski.net";
const MC_SERVER = "mc.rachlinski.net:25565";

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

function pingServer(ip, time) {
  rp(ip)
    .then((html) => {
      console.log("Server is up.");
      status.down = false;

      let lastDownMoment = moment(
        status.lastDowntimeNotification,
        DATE_FORMAT_STRING
      );

      if (moment().isAfter(lastDownMoment.add(HEARTBEAT_INTERVAL, "d"))) {
        console.log("Sending heartbeat notification");
        sendMail(
          `[Notification] Downtime detector still working.`,
          `Weekly notification.  RachlinskiNET is still up. Last crash detected at ${status.lastCrashDetected}.`
        );
        status.lastDowntimeNotification = time;
      }

      fs.writeFileSync(STATUS_FILE, JSON.stringify(status));
    })
    .catch((err) => {
      // If server is already down, we do not need to send another email
      if (status.down) {
        var lastDownMoment = moment(
          status.lastDowntimeNotification,
          DATE_FORMAT_STRING
        );
        var crashTime = moment(status.lastCrashDetected, DATE_FORMAT_STRING);

        console.log(
          `Server still down. Crash time ${crashTime}. last down moment: ${lastDownMoment}`
        );

        if (moment().isAfter(lastDownMoment.add(FOLLOW_UP_TIME, "h"))) {
          console.log(`Server still down, sending follow up email`);
          console.log(
            `Last email sent: ${lastDownMoment}, Currently: ${crashTime}`
          );
          sendMail(
            `[Warning] [${moment().format(
              DATE_FORMAT_STRING
            )}] Server is still down.`,
            `Server was detected as down at ${crashTime} and is still offline.\nDetails:\n` +
              `URL Pinged: ${ip}\nStatus Code: ${err.statusCode}\n` +
              `Error Response Below:` +
              `\n\n------- Error Response -------\n\n${JSON.stringify(err)}`
          );

          status.lastDowntimeNotification = time;
        } else {
          console.log("Not sending email");
        }
        fs.writeFileSync(STATUS_FILE, JSON.stringify(status));
      } else {
        console.error("Server down, sending email.");
        //console.error(JSON.stringify(err));
        sendMail(
          `[Warning] [${time}] Server did not respond to ping`,
          `Server was detected as down at ${time}.\n` +
            `URL Pinged: ${ip}\nStatus Code: ${err.statusCode}\n` +
            `Error response below:` +
            `\n\n------- Error Response -------\n\n${JSON.stringify(err)}`
        );

        status.down = true;
        status.lastDowntimeNotification = time;
        status.lastCrashDetected = time;

        fs.writeFileSync(STATUS_FILE, JSON.stringify(status));
      }
    });
}

async function sendMail(subject, body) {
  let transporter = await createTransporter();

  return new Promise((resolve, reject) => {
    var mailOptions = {
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

if (process.argv[2] == "test") {
  console.log("Sending test mail");
  sendMail("[Test] Test of RachlinskiNET Downtime checker", "test test test");
} else {
  var m = moment().format(DATE_FORMAT_STRING);

  console.log("Checking uptime");
  pingServer(SERVER, m);
}
