import express from "express";
import Groq from "groq-sdk";
import cors from "cors";
import dotenv from "dotenv";
import { Resend } from "resend";

dotenv.config();

const app = express();

/* ---------------- CORS + PREFLIGHT FIX ---------------- */

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86400,
}));

app.use(express.json());

/* ---------------- GROQ ---------------- */

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/* ---------------- RESEND ---------------- */

const resend = new Resend(process.env.RESEND_API_KEY);

/* ---------------- MEMORY ---------------- */

const sessions = {};

/* ---------------- HELPERS ---------------- */

function isValid(v) {
  if (!v) return false;

  const val = v.toLowerCase().trim();

  return val !== "unknown" && val !== "not specified";
}

function isEmail(v) {
  return /\S+@\S+\.\S+/.test(v);
}

function isPhone(v) {
  return /^[0-9]{10}$/.test(v);
}

function getLeadScore(budget, timeline) {
  const highBudget = /cr|crore/i.test(budget);
  const fastTimeline = /immediate|now|1|2|3 month/i.test(timeline);

  if (highBudget && fastTimeline) return "HOT";
  if (highBudget || fastTimeline) return "WARM";

  return "COLD";
}

/* ---------------- HEALTH ---------------- */

app.get("/", (req, res) => {
  res.send("🚀 Property AI Running");
});

/* ---------------- API ---------------- */

app.post("/lead", async (req, res) => {
  try {

    const { message, sessionId } = req.body;

    if (!message || !sessionId) {
      return res.status(400).json({
        success: false,
        message: "message & sessionId required",
      });
    }

    /* ---------- INIT SESSION ---------- */

    if (!sessions[sessionId]) {

      sessions[sessionId] = {
        chat: [],
        stage: "property",

        summary: {
          intent: "",
          budget: "",
          location: "",
          timeline: "",
        },

        contact: {
          name: "",
          email: "",
          phone: "",
        },
      };
    }

    const session = sessions[sessionId];

    session.chat.push({
      role: "user",
      content: message,
    });

    /* ---------- SYSTEM PROMPT ---------- */

    const systemPrompt = `
You are a smart real estate sales assistant.

CURRENT USER DATA:
${JSON.stringify(session.summary, null, 2)}

CONTACT DATA:
${JSON.stringify(session.contact, null, 2)}

STAGE:
${session.stage}

GOAL:
1. Collect:
- intent (investment or self-use)
- budget
- location
- timeline

2. Then collect:
- name
- contact (phone or email)

RULES:
- NEVER ask for already filled data
- If user gives multiple details → extract all
- Ask ONLY one question at a time
- Be short, natural, human-like
- Do NOT repeat questions

Return ONLY JSON:

{
  "reply": "",
  "summary": {
    "intent": "",
    "budget": "",
    "location": "",
    "timeline": ""
  },
  "contact": {
    "name": "",
    "email": "",
    "phone": ""
  }
}
`;

    /* ---------- AI CALL ---------- */

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",

      messages: [
        {
          role: "system",
          content: systemPrompt,
        },

        ...session.chat.slice(-10),
      ],
    });

    const raw = completion.choices[0].message.content;

    /* ---------- SAFE PARSE ---------- */

    let parsed;

    try {

      const match = raw.match(/\{[\s\S]*\}/);

      parsed = JSON.parse(match[0]);

      if (!parsed.reply) {
        throw new Error("Invalid AI response");
      }

    } catch {

      parsed = {
        reply: "Got it 👍 Could you tell me your budget?",
        summary: {},
        contact: {},
      };
    }

    /* ---------- SAFE MERGE ---------- */

    const newSummary = parsed.summary || {};
    const newContact = parsed.contact || {};

    if (isValid(newSummary.intent)) {
      session.summary.intent = newSummary.intent;
    }

    if (isValid(newSummary.budget)) {
      session.summary.budget = newSummary.budget;
    }

    if (isValid(newSummary.location)) {
      session.summary.location = newSummary.location;
    }

    if (isValid(newSummary.timeline)) {
      session.summary.timeline = newSummary.timeline;
    }

    if (newContact.name && !session.contact.name) {
      session.contact.name = newContact.name;
    }

    if (isEmail(newContact.email)) {
      session.contact.email = newContact.email;
    }

    if (isPhone(newContact.phone)) {
      session.contact.phone = newContact.phone;
    }

    session.chat.push({
      role: "assistant",
      content: parsed.reply,
    });

    /* ---------- STAGE CONTROL ---------- */

    const s = session.summary;

    const propertyComplete =
      isValid(s.intent) &&
      isValid(s.budget) &&
      isValid(s.location) &&
      isValid(s.timeline);

    const contactComplete =
      session.contact.name &&
      (session.contact.email || session.contact.phone);

    if (propertyComplete && session.stage === "property") {
      session.stage = "contact";
    }

    if (contactComplete && session.stage === "contact") {
      session.stage = "done";
    }

    /* ---------- CONTACT FLOW ---------- */

    if (session.stage === "contact" && !contactComplete) {

      if (!session.contact.name) {

        parsed.reply = "Great 👍 May I know your name?";

      } else if (
        !session.contact.email &&
        !session.contact.phone
      ) {

        parsed.reply =
          "How should we contact you? Phone or email?";
      }
    }

    /* ---------- FINAL ---------- */

    if (session.stage === "done") {

      const leadScore = getLeadScore(
        s.budget,
        s.timeline
      );

      /* ---------- SEND EMAIL ---------- */

      try {

        await resend.emails.send({

          from: "onboarding@resend.dev",

          to: process.env.EMAIL_USER,

          subject: `🔥 Property Lead - ${s.budget} - ${s.location}`,

          html: `
            <h2>🏡 New Lead</h2>

            <p><b>Name:</b> ${session.contact.name}</p>
            <p><b>Email:</b> ${session.contact.email || "-"}</p>
            <p><b>Phone:</b> ${session.contact.phone || "-"}</p>

            <ul>
              <li><b>Intent:</b> ${s.intent}</li>
              <li><b>Budget:</b> ${s.budget}</li>
              <li><b>Location:</b> ${s.location}</li>
              <li><b>Timeline:</b> ${s.timeline}</li>
              <li><b>Lead Score:</b> ${leadScore}</li>
            </ul>
          `,
        });

        console.log("✅ EMAIL SENT");

      } catch (emailErr) {

        console.error("❌ EMAIL FAILED:", emailErr);
      }

      parsed.reply =
        "Thanks! 😊 Our expert will contact you shortly with best property options.";

      delete sessions[sessionId];
    }

    /* ---------- RESPONSE ---------- */

    res.json({
      success: true,
      data: parsed,
    });

  } catch (err) {

    console.error("❌ SERVER ERROR:", err);

    res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
});

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
});
