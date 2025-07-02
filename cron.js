const cron = require("node-cron");
const fetch = require("node-fetch");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const isBetween = require("dayjs/plugin/isBetween");
const fs = require("fs");
const path = require("path");

dayjs.extend(utc);
dayjs.extend(isBetween);

console.log("OCR Cron Job Script Initialized");
const scheduledTasks = new Map();
function clearScheduledJobs() {
  for (const [jobId, task] of scheduledTasks.entries()) {
    task.stop();
    scheduledTasks.delete(jobId);
  }
}

const getDBConnectionType = () => {
  try {
    const filePath = path.join(__dirname, "db-config.json");

    if (!fs.existsSync(filePath)) {
      console.error("db-config.json not found.");
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const config = JSON.parse(raw);

    const dbType = config.dbType;
    console.log("DB Type:", dbType);
    return dbType;
  } catch (err) {
    console.error("Error reading DB config:", err.message);
  }
};

async function runOcrForJob(
  job,
  ocrUrl,
  baseUrl,
  wmsUrl,
  userName,
  passWord,
  dayOffset,
  fetchLimit
) {
  console.log("ocr script started.");
  const dbConnectionType = getDBConnectionType();
  console.log("db connection-> ", dbConnectionType);
  try {
    const retrieveRes = await fetch(
      `http://localhost:3000/api/pod/retrieve?dayOffset=${dayOffset}&fetchLimit=${fetchLimit}`
    );
    const fileList = await retrieveRes.json();
    console.log("file list-> ", fileList);

    for (const item of fileList) {
      try {
        const fileId = item.FILE_ID || item.file_id;
        const fileTable = item.FILE_TABLE || item.file_table;
        const fileRes = await fetch(
          `http://localhost:3000/api/pod/file?fileId=${fileId}&fileTable=${fileTable}`
        );
        if (!fileRes.ok) continue;

        const fileData = await fileRes.json();

        await fetch("http://localhost:3000/api/pod/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: fileData.FILE_ID }),
        });

        const filePath = `${baseUrl}/api/access-file?filename=${encodeURIComponent(
          fileData.FILE_NAME
        )}`;
        console.log("file path-> ", filePath);
        const ocrRes = await fetch(ocrUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ _id: fileId, file_url_or_path: filePath }),
        });

        if (!ocrRes.ok) {
          const errJson = await ocrRes.json().catch(() => null);
          throw new Error(errJson?.error || "OCR Failed");
        }

        const ocrData = await ocrRes.json();
        console.log("ocrData-> ", ocrData);
        if (!Array.isArray(ocrData)) continue;

        const processed = ocrData.map((d) => ({
          _id: fileId,
          jobId: job._id,
          fileId: fileId,
          pdfUrl: decodeURIComponent(
            new URL(filePath).searchParams.get("filename") || ""
          ),
          deliveryDate: new Date().toISOString().split("T")[0],
          noOfPages: 1,
          blNumber: String(d?.B_L_Number || ""),
          podDate: d?.POD_Date || "",
          podSignature: d?.Signature_Exists || "unknown",
          totalQty: Number(d?.Issued_Qty) || 0,
          received: Number(d?.Received_Qty) || 0,
          damaged: d?.Damage_Qty,
          short: d?.Short_Qty,
          over: d?.Over_Qty,
          refused: d?.Refused_Qty,
          customerOrderNum: d?.Customer_Order_Num,
          stampExists: d?.Stamp_Exists,
          finalStatus: "valid",
          reviewStatus: "unConfirmed",

          recognitionStatus:
            {
              failed: "failure",
              valid: "valid",
              "partially valid": "partiallyValid",
            }[d?.Status] || "null",
          breakdownReason: "none",
          reviewedBy: "OCR Engine",
          uptd_Usr_Cd: "OCR",
          cargoDescription: "Processed from OCR API.",
          none: "N",
          sealIntact: d?.Seal_Intact === "yes" ? "Y" : "N",
        }));

        const single = processed[0];
        console.log("data-> ", ocrData);
        // SAP BOL matching
        try {
          const basicAuth = Buffer.from(`${userName}:${passWord}`).toString(
            "base64"
          );
          const response = await fetch(wmsUrl, {
            method: "POST",
            headers: {
              Authorization: `Basic ${basicAuth}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ BOLNo: [single.blNumber] }),
          });

          const sapData = await response.json();
          if (sapData[0]?.BOLNo?.trim() === single.blNumber.trim()) {
            single.recognitionStatus = "valid";
            processed[0].recognitionStatus = "valid";
          } else {
            single.recognitionStatus = "failure";
            processed[0].recognitionStatus = "failure";
          }
        } catch (err) {
          console.error("SAP check error:", err.message);
        }
        console.log("data1-> ", ocrData);

        const confirmRes = await fetch(
          "http://localhost:3000/api/settings/auto-confirmation"
        );
        const confirmJson = await confirmRes.json();
        console.log("data2-> ", ocrData);


        if (confirmJson.isAutoConfirmationOpen) {
          await fetch("http://localhost:3000/api/pod/update", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fileId: fileData.FILE_ID,
              ocrData: single,
            }),
          });
        }

        await fetch("http://localhost:3000/api/process-data/save-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(processed),
        });

        console.log(`File ${fileId} processed.`);
      } catch (err) {
        console.error("File processing error:", err);
      }
    }
  } catch (err) {
    console.error("OCR job error:", err.message);
  }
}

function getCronExpressionFromTime(timeStr) {
  const [hours, minutes] = timeStr.split(":").map(Number);

  if (hours === 0 && minutes > 0) {
    return `*/${minutes} * * * *`;
  }

  if (minutes === 0 && hours > 0) {
    return `0 */${hours} * * *`;
  }

  if (hours > 0 && minutes > 0) {
    return `${minutes} */${hours} * * *`;
  }

  return "* * * * *";
}

async function scheduleJobs() {
  try {
    const dbResponse = await fetch("http://localhost:3000/api/auth/public-db");
    const dbData = await dbResponse.json();

    if (dbData?.database !== "remote") {
      console.log("Database is not remote. Skipping job scheduling.");
      return;
    }

    const ipRes = await fetch("http://localhost:3000/api/ipAddress/ip-address");
    const ipData = await ipRes.json();
    const baseUrl = `http://${ipData.secondaryIp}:3000`;
    const ocrUrl = `http://${ipData.ip}:8080/run-ocr`;

    const wmsRes = await fetch("http://localhost:3000/api/save-wms-url");
    const {
      wmsUrl,
      username: userName,
      password: passWord,
    } = await wmsRes.json();

    const jobRes = await fetch("http://localhost:3000/api/jobs/get-job");
    const jobJson = await jobRes.json();
    const jobs = jobJson.activeJobs;

    clearScheduledJobs();

    for (const job of jobs) {
      const intervalStr = job.everyTime;
      const cronExp = getCronExpressionFromTime(intervalStr);

      const task = cron.schedule(cronExp, async () => {
        const now = new Date();
        const currentDay = now.toLocaleString("en-US", { weekday: "long" });
        const currentTimeStr = `${String(now.getHours()).padStart(
          2,
          "0"
        )}:${String(now.getMinutes()).padStart(2, "0")}`;

        const fromTime = new Date(job.pdfCriteria.fromTime);
        const toTime = new Date(job.pdfCriteria.toTime);
        const fromTimeStr = `${String(fromTime.getUTCHours()).padStart(
          2,
          "0"
        )}:${String(fromTime.getUTCMinutes()).padStart(2, "0")}`;
        const toTimeStr = `${String(toTime.getUTCHours()).padStart(
          2,
          "0"
        )}:${String(toTime.getUTCMinutes()).padStart(2, "0")}`;
        console.log("currentday-> ", currentDay);
        console.log("currentTimeStr-> ", currentTimeStr);
        console.log("fromTime-> ", fromTime);
        console.log("toTime-> ", toTime);
        console.log("fromTimeStr-> ", fromTimeStr);

        if (
          job.selectedDays.includes(currentDay) &&
          currentTimeStr >= fromTimeStr &&
          currentTimeStr <= toTimeStr
        ) {
          console.log(`Running OCR Job: ${job._id}`);
          runOcrForJob(
            job,
            ocrUrl,
            baseUrl,
            wmsUrl,
            userName,
            passWord,
            job.dayOffset,
            job.fetchLimit
          );
        }
      });

      scheduledTasks.set(job._id, task);
      console.log(`Scheduled job ${job._id} with cron: ${cronExp}`);
    }
  } catch (err) {
    console.error("Scheduling failed:", err.message);
  }
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function waitForAPI(retries = 10, interval = 2000) {
  const url = "http://localhost:3000/api/auth/public-db";
  while (retries--) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log("API is up, starting scheduler...");
        await scheduleJobs();
        return;
      }
    } catch (err) {
      console.log("Waiting for API to be ready...");
      await delay(interval);
    }
  }
  console.error("API failed to respond after multiple retries.");
}
waitForAPI();
setInterval(() => {
  console.log("Checking for updated jobs...");
  scheduleJobs();
}, 60000);
