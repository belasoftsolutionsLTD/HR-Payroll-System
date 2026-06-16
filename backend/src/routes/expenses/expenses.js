const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { listExpenses, recordExpenses, updateExpense, deleteExpense } = require('./expenseFunctions');

const HR = ['super_admin', 'hr_manager'];

router.get('/expenses',        allowRoles(HR), AsyncHandler(listExpenses));
router.post('/expenses/batch', allowRoles(HR), AsyncHandler(recordExpenses));
router.put('/expenses/:id',    allowRoles(HR), AsyncHandler(updateExpense));
router.delete('/expenses/:id', allowRoles(HR), AsyncHandler(deleteExpense));

module.exports = router;
