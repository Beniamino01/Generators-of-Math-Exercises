(() => {
  function safeFileName(value) {
    return String(value ?? "worksheet")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "worksheet";
  }

  function humanizeSlug(value) {
    return String(value ?? "")
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  async function readErrorMessage(response) {
    try {
      const payload = await response.json();
      return payload?.error || "";
    } catch {
      return "";
    }
  }

  async function exportWorksheet(payload) {
    if (window.location.protocol === "file:") {
      throw new Error("LaTeX PDF export requires running the site through the Node server, not as a standalone HTML file.");
    }

    const fileName = safeFileName(payload?.fileName || payload?.title || "worksheet");
    const response = await fetch("/api/export-latex-pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...payload,
        fileName
      })
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("LaTeX PDF export needs the Node backend endpoint, so it will not work on static hosting alone.");
      }

      const errorMessage = await readErrorMessage(response);
      throw new Error(errorMessage || "LaTeX PDF generation failed.");
    }

    const pdfBlob = await response.blob();
    const downloadUrl = URL.createObjectURL(pdfBlob);
    const link = document.createElement("a");

    link.href = downloadUrl;
    link.download = `${fileName}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => {
      URL.revokeObjectURL(downloadUrl);
    }, 0);
  }

  window.LatexPdfExport = {
    exportWorksheet,
    humanizeSlug,
    safeFileName
  };
})();
