// Login credentials for the web application.  The username and passwords
// are kept separate from runtime settings to avoid accidental changes when
// editing the configuration from the settings page.  The main login password
// is stored as a bcrypt hash and can be updated offline with a tool like
// `bcryptjs` if needed.  The settings password is used to authorise changes
// on the /settings page.

module.exports = {
  // User name required to access the dashboard.  A separate password is
  // used for the settings page and must be provided there.
  username: "zavod",
  // Bcrypt hash of the login password.  The default password matches the
  // original build and may be updated by the operator.
  passwordHash: "$2b$12$v6Afhzj5VUp7/k3yC469VeWcbfD2ro3y9R9v9bfniTvh1nsuucYOu",
  // Plain settings password protecting the /settings interface.
  settingsPassword: "19910509",
};