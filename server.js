import express from "express";
import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const latexEngines = [
  {
    name: "tectonic",
    command: "tectonic",
    buildArgs: (texFile) => ["--outdir", ".", texFile]
  },
  {
    name: "pdflatex",
    command: "pdflatex",
    buildArgs: (texFile) => ["-interaction=nonstopmode", "-halt-on-error", texFile]
  },
  {
    name: "xelatex",
    command: "xelatex",
    buildArgs: (texFile) => ["-interaction=nonstopmode", "-halt-on-error", texFile]
  },
  {
    name: "lualatex",
    command: "lualatex",
    buildArgs: (texFile) => ["-interaction=nonstopmode", "-halt-on-error", texFile]
  }
];

app.use(express.static(publicDir));
app.use(express.json({ limit: "5mb" }));

function escapeLatexText(value) {
  const replacements = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "#": "\\#",
    "$": "\\$",
    "%": "\\%",
    "&": "\\&",
    "_": "\\_",
    "^": "\\^{}",
    "~": "\\~{}"
  };

  return String(value ?? "").replace(/[\\{}#$%&_~^]/g, (char) => replacements[char]);
}

function sanitizeFileName(value) {
  return String(value ?? "worksheet")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worksheet";
}

function unwrapStoredMath(value) {
  const text = String(value ?? "").trim();

  const displayMatch = text.match(/^\\\[(?<body>[\s\S]*)\\\]$/);
  if (displayMatch?.groups?.body) {
    return { kind: "math", body: displayMatch.groups.body.trim() };
  }

  const inlineMatch = text.match(/^\\\((?<body>[\s\S]*)\\\)$/);
  if (inlineMatch?.groups?.body) {
    return { kind: "math", body: inlineMatch.groups.body.trim() };
  }

  return { kind: "text", body: escapeLatexText(text) };
}

function renderLatexBody(value) {
  const unwrapped = unwrapStoredMath(value);
  if (unwrapped.kind === "math") {
    return `\\[\n${unwrapped.body}\n\\]`;
  }

  return unwrapped.body || "\\text{ }";
}

function renderLatexItems(exercises, field) {
  if (!exercises.length) {
    return "\\item \\textit{No content available.}";
  }

  return exercises.map((exercise, index) => {
    const label = exercise.tag ? `{\\small\\textbf{Topic:} ${escapeLatexText(exercise.tag)}}\\par` : "";
    const body = renderLatexBody(exercise[field]);
    const itemIndex = Number.isFinite(Number(exercise.index)) ? Number(exercise.index) : index + 1;

    return [
      "\\item",
      `{\\small\\textbf{${field === "s" ? "Solution" : "Exercise"} ${itemIndex}}}\\par`,
      label,
      body
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function buildLatexDocument(payload) {
  const title = escapeLatexText(payload.title || "Worksheet");
  const subject = escapeLatexText(payload.subject || "Worksheet");
  const difficulty = escapeLatexText(payload.difficulty || "Medium");
  const exercises = Array.isArray(payload.exercises)
    ? payload.exercises
        .slice(0, 100)
        .map((exercise, index) => ({
          index: exercise?.index ?? index + 1,
          tag: exercise?.tag ?? "",
          q: exercise?.q ?? "",
          s: exercise?.s ?? ""
        }))
    : [];

  const exerciseItems = renderLatexItems(exercises, "q");
  const solutionItems = renderLatexItems(exercises, "s");
  const includeSolutions = Boolean(payload.includeSolutions);

  return `
\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=2cm]{geometry}
\\usepackage{amsmath,amssymb}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0.6em}
\\begin{document}
\\begin{center}
{\\LARGE\\bfseries ${title}\\\\[0.35em]}
{\\large ${subject}}\\\\[0.25em]
{\\normalsize Difficulty: ${difficulty}}
\\end{center}

\\section*{Exercises}
\\begin{enumerate}
${exerciseItems}
\\end{enumerate}
${includeSolutions ? `

\\newpage
\\section*{Solutions}
\\begin{enumerate}
${solutionItems}
\\end{enumerate}
` : ""}
\\end{document}
`.trimStart();
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`${command} exited with code ${code}`);
      error.exitCode = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function compileLatexToPdf(latexSource) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "worksheet-latex-"));
  const texFile = "worksheet.tex";
  const texPath = path.join(tempDir, texFile);
  const pdfPath = path.join(tempDir, "worksheet.pdf");

  try {
    await fs.writeFile(texPath, latexSource, "utf8");

    let missingEngineCount = 0;
    let lastError = null;

    for (const engine of latexEngines) {
      try {
        await runCommand(engine.command, engine.buildArgs(texFile), tempDir);
        const pdfBuffer = await fs.readFile(pdfPath);
        return { engine: engine.name, pdfBuffer };
      } catch (error) {
        if (error.code === "ENOENT") {
          missingEngineCount += 1;
          continue;
        }

        lastError = error;
      }
    }

    if (missingEngineCount === latexEngines.length) {
      const error = new Error("No LaTeX compiler found on the server.");
      error.userMessage = "LaTeX PDF export requires Tectonic, pdfLaTeX, XeLaTeX, or LuaLaTeX to be installed on the server.";
      throw error;
    }

    const error = new Error("LaTeX compilation failed.");
    error.userMessage = "The LaTeX compiler ran, but the PDF could not be generated. Check the server logs for details.";
    error.cause = lastError;
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

app.get("/", (_, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/integrals", (_, res) => {
  res.sendFile(path.join(publicDir, "integrals.html"));
});

app.get("/derivatives", (_, res) => {
  res.sendFile(path.join(publicDir, "derivatives.html"));
});

app.get("/limits", (_, res) => {
  res.sendFile(path.join(publicDir, "limits.html"));
});

app.get("/series", (_, res) => {
  res.sendFile(path.join(publicDir, "series.html"));
});

app.get("/exam-mode", (_, res) => {
  res.sendFile(path.join(publicDir, "exam-mode.html"));
});

app.get("/complete-site", (_, res) => {
  res.sendFile(path.join(publicDir, "Sitocompleto_modificato.html"));
});

app.post("/api/export-latex-pdf", async (req, res) => {
  const exercises = Array.isArray(req.body?.exercises) ? req.body.exercises : [];
  if (!exercises.length) {
    res.status(400).json({ error: "No exercises were provided for the PDF export." });
    return;
  }

  try {
    const latexSource = buildLatexDocument(req.body);
    const { engine, pdfBuffer } = await compileLatexToPdf(latexSource);
    const safeFileName = sanitizeFileName(req.body?.fileName || req.body?.title || "worksheet");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}.pdf"`);
    res.setHeader("X-Latex-Engine", engine);
    res.send(pdfBuffer);
  } catch (error) {
    console.error("LaTeX PDF export failed:", error);
    res.status(500).json({
      error: error.userMessage || "LaTeX PDF generation failed on the server."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
