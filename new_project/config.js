// Login credentials for the web application.  The username and password
// are kept separate from runtime settings to avoid accidental changes when
// editing the configuration from the settings page.  The password is
// stored as a bcrypt hash and can be updated offline with a tool like
// `bcryptjs` if needed.

module.exports = {
  // User name required to access the dashboard.  A separate password is
  // used for the settings page and must be provided there.
  username: "zavod",
  // Bcrypt hash of the password.  The default password matches the
  // original build and may be updated by the operator.
  passwordHash: "$2b$12$v6Afhzj5VUp7/k3yC469VeWcbfD2ro3y9R9v9bfniTvh1nsuucYOu"
};