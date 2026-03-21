const fs = require('fs');
const path = require('path');
const os = require('os');

const REAL_CONFIG = path.join(os.homedir(), '.claude-radar', 'config.json');
const BACKUP = REAL_CONFIG + '.test-backup';

module.exports = async function () {
  // Back up real config before tests
  if (fs.existsSync(REAL_CONFIG)) {
    fs.copyFileSync(REAL_CONFIG, BACKUP);
  }
};
