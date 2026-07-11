import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();
const PORT = 3000;

// Enable large JSON payloads for audio data (base64)
app.use(express.json({ limit: "50mb" }));

// Initialize Gemini SDK
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Initialize Firebase SDK using firebase-applet-config.json
let db: any = null;
try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const firebaseApp = initializeApp(firebaseConfig);
    const databaseId = firebaseConfig.firestoreDatabaseId || "(default)";
    db = getFirestore(firebaseApp, databaseId);
    console.log(`Firebase Firestore initialized successfully with database: ${databaseId}`);
  } else {
    console.warn("firebase-applet-config.json not found. Firestore will not be available.");
  }
} catch (err) {
  console.error("Error initializing Firebase:", err);
}

// Simple in-memory storage for sent emails log (for testing / simulation)
const sentEmailsLog: Array<{
  id: string;
  to: string;
  subject: string;
  body: string;
  passkey: string;
  sentAt: string;
}> = [];

// ==================== API ROUTES ====================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", firebaseAvailable: db !== null });
});

// 1. Audio transcription route
app.post("/api/transcribe", async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) {
       res.status(400).json({ error: "No audio data provided" });
       return;
    }

    // Sanitize MIME type (e.g. "audio/webm;codecs=opus" -> "audio/webm")
    let cleanMimeType = (mimeType || "audio/webm").split(";")[0].trim();
    if (!cleanMimeType.startsWith("audio/")) {
      cleanMimeType = "audio/webm";
    }

    console.log("Processing audio transcription request. Size:", audio.length, "Original Mime:", mimeType, "Cleaned Mime:", cleanMimeType);

    // Call Gemini 3.5-flash with audio part
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        {
          inlineData: {
            mimeType: cleanMimeType,
            data: audio,
          },
        },
        "You are an expert clinical audio transcriptionist. Transcribe this doctor-patient audio consultation accurately. Standardize speaker turns using 'Doctor:' and 'Patient:' based on context. Maintain medical terminology, prescriptions, and dosage accuracy.",
      ],
    });

    const transcript = response.text || "Transcription failed or returned no text.";
    res.json({ transcript });
  } catch (err: any) {
    console.error("Transcription API error:", err);
    res.status(500).json({ error: err.message || "An error occurred during transcription" });
  }
});

// 2. Summary generation route
app.post("/api/summarize", async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript) {
       res.status(400).json({ error: "No transcript provided" });
       return;
    }

    console.log("Generating summary from transcript...");

    // Request structured JSON output conforming to doctor summary format
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `You are an expert medical transcription summarizer. Extract clinical details from the doctor-patient transcription below and populate the structured JSON fields. Only include details explicitly mentioned in the text. Write 'None discussed' for empty/unmentioned fields.
      
Transcript:
${transcript}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            chiefComplaint: {
              type: Type.STRING,
              description: "The primary symptoms or reasons why the patient scheduled the visit.",
            },
            symptoms: {
              type: Type.STRING,
              description: "All symptoms discussed during the consultation.",
            },
            diagnosis: {
              type: Type.STRING,
              description: "Clinical impression, suspicion, or confirmed diagnosis stated by the doctor.",
            },
            prescription: {
              type: Type.STRING,
              description: "Medicine name, dosage, frequency, and duration explicitly mentioned.",
            },
            precautions: {
              type: Type.STRING,
              description: "Warnings, risks, side effects or emergency actions.",
            },
            dietLifestyle: {
              type: Type.STRING,
              description: "Nutrition, exercise, rest, or hydration suggestions.",
            },
            followUp: {
              type: Type.STRING,
              description: "Target dates, trigger conditions, or appointment schedules for follow-up.",
            },
            additionalNotes: {
              type: Type.STRING,
              description: "Other clinical notes or observations.",
            },
          },
          required: [
            "chiefComplaint",
            "symptoms",
            "diagnosis",
            "prescription",
            "precautions",
            "dietLifestyle",
            "followUp",
            "additionalNotes",
          ],
        },
      },
    });

    const jsonText = response.text;
    if (!jsonText) {
      throw new Error("Gemini returned empty response text");
    }

    const summary = JSON.parse(jsonText);
    res.json({ summary });
  } catch (err: any) {
    console.error("Summarize API error:", err);
    res.status(500).json({ error: err.message || "An error occurred during summary generation" });
  }
});

// 3. Create Report & Send Access Code Route
app.post("/api/reports", async (req, res) => {
  try {
    const { patientName, patientPhone, patientEmail, transcript, summary, consultationDate } = req.body;

    if (!patientName || !patientEmail || !summary) {
       res.status(400).json({ error: "Missing required report details" });
       return;
    }

    if (!db) {
       res.status(500).json({ error: "Firestore database not available" });
       return;
    }

    // Generate a secure random UUID for the report ID
    const reportId = "rep_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    // Generate a random 6-digit passkey
    const passkey = Math.floor(100000 + Math.random() * 900000).toString();

    // Store in Firestore
    const reportDoc = {
      id: reportId,
      patientName,
      patientPhone: patientPhone || "",
      patientEmail,
      consultationDate: consultationDate || new Date().toISOString().split("T")[0],
      transcript: transcript || "",
      passkey, // Stored securely in database (direct verification)
      summary,
      isApproved: true,
      createdAt: new Date().toISOString(),
    };

    await setDoc(doc(db, "reports", reportId), reportDoc);

    // Build unique access link
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const reportLink = `${appUrl}/?reportId=${reportId}`;

    // Simulate sending email (print to console & store in our mock list)
    const emailBody = `Hello ${patientName},

Your consultation summary report from ConsultNotes is ready.
To view your secure clinical report, please click the link below:
${reportLink}

For privacy and security, you will be prompted to enter your secure access code.
Your Access Code: ${passkey}

Disclaimer: This report is a confidential health document. Do not share your access code.`;

    sentEmailsLog.push({
      id: "msg_" + Math.random().toString(36).substring(2, 9),
      to: patientEmail,
      subject: "Secure Consultation Report Access - ConsultNotes",
      body: emailBody,
      passkey,
      sentAt: new Date().toLocaleTimeString(),
    });

    console.log(`
==================================================
📧 EMAIL TRANSMISSION SIMULATION (ConsultNotes)
TO: ${patientEmail}
SUBJECT: Secure Consultation Report Access
LINK: ${reportLink}
ACCESS CODE: ${passkey}
==================================================
`);

    res.json({
      success: true,
      reportId,
      passkey,
      link: reportLink,
    });
  } catch (err: any) {
    console.error("Create report error:", err);
    res.status(500).json({ error: err.message || "Failed to create and send report" });
  }
});

// 4. Verify Passkey & Retrieve Report Route
app.post("/api/reports/:id/verify", async (req, res) => {
  try {
    const reportId = req.params.id;
    const { passkey } = req.body;

    if (!passkey) {
       res.status(400).json({ error: "Passkey is required" });
       return;
    }

    if (!db) {
       res.status(500).json({ error: "Firestore database not available" });
       return;
    }

    const docRef = doc(db, "reports", reportId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
       res.status(404).json({ error: "Report not found" });
       return;
    }

    const reportData = docSnap.data();

    // Verify passkey matching (trim to avoid any spaces, standard check)
    if (reportData.passkey.trim() !== passkey.trim()) {
       res.status(401).json({ error: "Incorrect access code. Access denied." });
       return;
    }

    // Return the report details without the plaintext passkey
    const { passkey: _, ...safeReport } = reportData;
    res.json({ success: true, report: safeReport });
  } catch (err: any) {
    console.error("Verify report error:", err);
    res.status(500).json({ error: err.message || "Verification failed" });
  }
});

// 5. Public metadata route (to show patient a welcome greeting safely)
app.get("/api/reports/:id/public", async (req, res) => {
  try {
    const reportId = req.params.id;
    if (!db) {
       res.status(500).json({ error: "Firestore database not available" });
       return;
    }

    const docRef = doc(db, "reports", reportId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
       res.status(404).json({ error: "Report not found" });
       return;
    }

    const reportData = docSnap.data();
    // Return ONLY date and a secure indication of doctor name (or just date & app name)
    // Avoid returning patientName or other PII before verification!
    res.json({
      consultationDate: reportData.consultationDate,
      available: true,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch report metadata" });
  }
});

// 6. Get mock email list for easy testing in development/preview
app.get("/api/emails", (req, res) => {
  res.json({ emails: sentEmailsLog });
});

// ==================== VITE MIDDLEWARE / STATIC FILES ====================

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
