// Central error handler. Any route that calls next(err), or any
// synchronous throw inside an async route wrapped with asyncHandler,
// ends up here so we always send back a consistent JSON error shape
// and never leak stack traces to the client in production.

function notFound(req, res, next) {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
}

// Multer's own error messages ("Too many files", "Unexpected field") are not
// useful to an admin filling in a form, so they're translated to the same
// wording used by the client-side validation in admin/products.html.
const MULTER_MESSAGES = {
  LIMIT_FILE_COUNT: 'Maximum 10 images are allowed per product.',
  LIMIT_UNEXPECTED_FILE: 'Maximum 10 images are allowed per product.',
  LIMIT_FILE_SIZE: 'One of your images is too large. Each image must be a reasonable file size (a few MB or less).'
};

function errorHandler(err, req, res, next) {
  console.error('❌ ERROR:', err.message);
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  if (err.name === 'MulterError' && MULTER_MESSAGES[err.code]) {
    return res.status(400).json({ success: false, message: MULTER_MESSAGES[err.code] });
  }

  const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;

  // Unexpected failures (database errors and the like) are logged above but
  // not shown to visitors in production, since their text can reveal table or
  // column names. Deliberate errors (those that set a statusCode) keep their message.
  const hideDetails = statusCode === 500 && process.env.NODE_ENV === 'production';

  res.status(statusCode).json({
    success: false,
    message: hideDetails ? 'Something went wrong on the server. Please try again.' : (err.message || 'Something went wrong on the server.'),
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
}

// Wraps async route handlers so thrown errors are forwarded to errorHandler
// instead of crashing the process.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { notFound, errorHandler, asyncHandler };
