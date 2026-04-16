import express from "express";
import Groq from "groq-sdk";
import cors from "cors";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// 🔑 ENV (use Render env vars in prod)
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// 🧠 Memory
const sessions = {};

// 📧 Email
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 📊 Google Sheets
// const auth = new google.auth.GoogleAuth({
//   keyFile: "service-account.json",
//   scopes: ["https://www.googleapis.com/auth/spreadsheets"],
// });

// const sheets = google.sheets({ version: "v4", auth });

// const SPREADSHEET_ID = "YOUR_SHEET_ID";

// 🔧 Helpers
function isValid(value) {
  if (!value) return false;
  const v = value.toLowerCase().trim();
  return v !== "unknown" && v !== "not specified";
}

// passing data to google sheets
// async function saveToGoogleSheets(name, message, summary) {
//   await sheets.spreadsheets.values.append({
//     spreadsheetId: SPREADSHEET_ID,
//     range: "Sheet1!A:G",
//     valueInputOption: "USER_ENTERED",
//     requestBody: {
//       values: [[
//         name,
//         message,
//         summary.intent,
//         summary.budget,
//         summary.urgency,
//         summary.action,
//         new Date().toLocaleString()
//       ]]
//     }
//   });
// }

async function sendLeadEmail(name, message, summary, history) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_USER,
    subject: "🔥 New Lead Received",
    html: `
      <h2>New Lead</h2>
      <p><b>Name:</b> ${name}</p>
      <p><b>Message:</b> ${message}</p>

      <h3>Insights</h3>
      <ul>
        <li>Intent: ${summary.intent}</li>
        <li>Budget: ${summary.budget}</li>
        <li>Urgency: ${summary.urgency}</li>
        <li>Action: ${summary.action}</li>
      </ul>

      <h3>Conversation</h3>
      <pre>${JSON.stringify(history, null, 2)}</pre>
    `
  });
}

// 🚀 API
app.post("/lead", async (req, res) => {
  const { name, message, sessionId } = req.body;

  if (!sessions[sessionId]) sessions[sessionId] = [];

  sessions[sessionId].push({ role: "user", content: message });

  const systemPrompt = `
You are a smart sales assistant.

RULES:
- Do NOT ask repeated questions
- Ask only missing info
- If all details collected → say thank you

Return ONLY JSON:

{
  "reply": "",
  "summary": {
    "intent": "",
    "budget": "",
    "urgency": "",
    "action": ""
  }
}
`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        ...sessions[sessionId]
      ],
    });

    const text = completion.choices[0].message.content;

    let parsed;

    try {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match[0]);
    } catch {
      parsed = {
        reply: text,
        summary: {
          intent: "Unknown",
          budget: "Unknown",
          urgency: "Unknown",
          action: "Manual review"
        }
      };
    }

    sessions[sessionId].push({
      role: "assistant",
      content: parsed.reply
    });

    // ✅ Final stage → save + email + clear session
    if (
      isValid(parsed.summary.intent) &&
      isValid(parsed.summary.budget) &&
      isValid(parsed.summary.urgency)
    ) {
    //   await saveToGoogleSheets(name, message, parsed.summary);
      await sendLeadEmail(name, message, parsed.summary, sessions[sessionId]);

      parsed.reply = `Thanks ${name}! 😊 Our team will contact you shortly.`;

      delete sessions[sessionId];
    }

    res.json({ success: true, data: parsed });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.listen(3000, () => {
  console.log("🔥 Server running on port 3000");
});