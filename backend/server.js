const app = require('./app');

const PORT = process.env.PORT || 5000;

// Wait for the DB connection before accepting any traffic — otherwise requests can
// arrive (and hit `global.dbo` while it's still undefined) in the window between the
// server binding its port and the MongoDB connection actually completing.
app.dbReady.then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
