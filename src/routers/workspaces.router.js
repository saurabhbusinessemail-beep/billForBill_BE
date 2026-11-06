'use strict';

const express = require('express');
const { listWorkspaces, listWorkingAtWorkspaces, updateSetupChoice } = require('../controllers/workspaces.controller');
const { requireSession } = require('../middleware/requireSession');

const router = express.Router();

router.get('/', requireSession, listWorkspaces);
router.get('/working-at', requireSession, listWorkingAtWorkspaces);
router.put('/setup-choice', requireSession, updateSetupChoice);

module.exports = router;
