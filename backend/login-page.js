const path = require("path");
const express = require("express");
const router = express.Router();

router.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "../admin/index.html"));
});

router.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "../admin/dashboard.html"));
});

module.exports = router;
