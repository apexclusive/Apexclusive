import https from "https";
import http from "http";

export default async function handler(req, res) {

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      error: "Geen URL opgegeven"
    });
  }

  try {

    const response = await fetch(url, {
      headers: {
        "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    });

    const html = await response.text();

    res.status(200).json({
      html: html
    });

  } catch(e) {

    res.status(500).json({
      error: e.message
    });

  }
}
