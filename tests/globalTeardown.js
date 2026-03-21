const fs = require('fs');
const path = require('path');
const os = require('os');

const REAL_CONFIG = path.join(os.homedir(), '.claude-radar', 'config.json');
const BACKUP = REAL_CONFIG + '.test-backup';

module.exports = async function () {
  // Restore real config after tests
  if (fs.existsSync(BACKUP)) {
    fs.copyFileSync(BACKUP, REAL_CONFIG);
    fs.unlinkSync(BACKUP);
  }
  // Clear env var
  delete process.env.CLAUDE_RADAR_CONFIG_DIR;
};
