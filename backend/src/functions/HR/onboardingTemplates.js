const getDefaultOnboardingTasks = (employeeId, hireDateString) => {
  const hireDate = new Date(hireDateString);
  const due = (daysOffset) => {
    const d = new Date(hireDate);
    d.setDate(d.getDate() + daysOffset);
    return d;
  };

  return [
    { employeeId, taskTitle: 'Issue staff ID card and access badges', assignedDepartment: 'Administration', dueDate: due(1), status: 'pending', createdAt: new Date() },
    { employeeId, taskTitle: 'Set up email account and system access', assignedDepartment: 'ICT', dueDate: due(1), status: 'pending', createdAt: new Date() },
    { employeeId, taskTitle: 'Complete HR documentation and file employee record', assignedDepartment: 'Administration', dueDate: due(2), status: 'pending', createdAt: new Date() },
    { employeeId, taskTitle: 'Payroll registration and bank details submission', assignedDepartment: 'Finance', dueDate: due(3), status: 'pending', createdAt: new Date() },
    { employeeId, taskTitle: 'Department orientation and introduction to team', assignedDepartment: 'Administration', dueDate: due(3), status: 'pending', createdAt: new Date() },
    { employeeId, taskTitle: 'Review school policies, code of conduct, and safeguarding guidelines', assignedDepartment: 'Administration', dueDate: due(5), status: 'pending', createdAt: new Date() },
    { employeeId, taskTitle: 'Complete health, safety, and first-aid induction', assignedDepartment: 'Administration', dueDate: due(7), status: 'pending', createdAt: new Date() },
  ];
};

module.exports = { getDefaultOnboardingTasks };
