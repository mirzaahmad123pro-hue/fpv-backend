// Must be used AFTER authenticate(). Blocks anyone whose role is not
// "admin" or "super_admin".

function requireAdmin(req, res, next) {
  if (!req.user || !['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }
  next();
}

// Only the highest privilege level — used for managing other admin accounts.
function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Super admin access required.' });
  }
  next();
}

module.exports = { requireAdmin, requireSuperAdmin };
