// System documented in https://zulip.readthedocs.io/en/latest/subsystems/logging.html

// This must be included before the first call to $(document).ready
// in order to be able to report exceptions that occur during their
// execution.

var blueslip_stacktrace = require("./blueslip_stacktrace");

if (Error.stackTraceLimit !== undefined) {
    Error.stackTraceLimit = 100000;
}

function Logger() {
    this._memory_log = [];
}

Logger.prototype = (function () {
    function pad(num, width) {
        var ret = num.toString();
        while (ret.length < width) {
            ret = "0" + ret;
        }
        return ret;
    }

    function make_logger_func(name) {
        return function Logger_func() {
            var now = new Date();
            var date_str =
                now.getUTCFullYear() + '-' +
                pad(now.getUTCMonth() + 1, 2) + '-' +
                pad(now.getUTCDate(), 2) + ' ' +
                pad(now.getUTCHours(), 2) + ':' +
                pad(now.getUTCMinutes(), 2) + ':' +
                pad(now.getUTCSeconds(), 2) + '.' +
                pad(now.getUTCMilliseconds(), 3) + ' UTC';

            var str_args = _.map(arguments, function (x) {
                if (typeof(x) === 'object') {
                    return JSON.stringify(x);
                } else {
                    return x;
                }
            });

            var log_entry = date_str + " " + name.toUpperCase() +
                ': ' + str_args.join("");
            this._memory_log.push(log_entry);

            // Don't let the log grow without bound
            if (this._memory_log.length > 1000) {
                this._memory_log.shift();
            }

            if (console[name] !== undefined) {
                return console[name].apply(console, arguments);
            }
            return;
        };
    }

    var proto = {
        get_log: function Logger_get_log() {
            return this._memory_log;
        }
    };

    var methods = ['debug', 'log', 'info', 'warn', 'error'];
    var i;
    for (i = 0; i < methods.length; i++) {
        proto[methods[i]] = make_logger_func(methods[i]);
    }

    return proto;
}());

var logger = new Logger();

exports.get_log = function blueslip_get_log() {
    return logger.get_log();
};

var reported_errors = {};
var last_report_attempt = {};

function report_error(msg, stack, opts) {
    opts = _.extend({show_ui_msg: false}, opts);

    if (stack === undefined) {
        stack = 'No stacktrace available';
    }

    if (page_params.debug_mode) {
        // In development, we display blueslip errors in the web UI,
        // to make them hard to miss.
        blueslip_stacktrace.display_stacktrace(msg, stack);
    }

    var key = ':' + msg + stack;
    if (reported_errors.hasOwnProperty(key)
        || (last_report_attempt.hasOwnProperty(key)
            // Only try to report a given error once every 5 minutes
            && (Date.now() - last_report_attempt[key] <= 60 * 5 * 1000)))
    {
        return;
    }

    last_report_attempt[key] = Date.now();

    // TODO: If an exception gets thrown before we setup ajax calls
    // to include the CSRF token, our ajax call will fail.  The
    // elegant thing to do in that case is to either wait until that
    // setup is done or do it ourselves and then retry.
    $.ajax({
        type:     'POST',
        url:      '/json/report/error',
        dataType: 'json',
        data:     { message: msg,
                    stacktrace: stack,
                    ui_message: opts.show_ui_msg,
                    more_info: JSON.stringify(opts.more_info),
                    href: window.location.href,
                    user_agent: window.navigator.userAgent,
                    log: logger.get_log().join("\n")},
        timeout:  3*1000,
        success:  function () {
            reported_errors[key] = true;
            if (opts.show_ui_msg && ui_report !== undefined) {
                // There are a few races here (and below in the error
                // callback):
                // 1) The ui_report module or something it requires might
                //    not have been compiled or initialized yet.
                // 2) The DOM might not be ready yet and so fetching
                //    the #home-error div might fail.

                // For (1) we just don't show the message if the ui
                // hasn't been loaded yet.  The user will probably
                // get another error once it does.  We can't solve
                // (2) by using $(document).ready because the
                // callback never gets called (I think what's going
                // on here is if the exception was raised by a
                // function that was called as a result of the DOM
                // becoming ready then the internal state of jQuery
                // gets messed up and our callback never gets
                // invoked).  In any case, it will pretty clear that
                // something is wrong with the page and the user will
                // probably try to reload anyway.
                ui_report.message("Oops.  It seems something has gone wrong. " +
                                  "The error has been reported to the fine " +
                                  "folks at Zulip, but, in the mean time, " +
                                  "please try reloading the page.",
                                  $("#home-error"), "alert-error");
            }
        },
        error: function () {
            if (opts.show_ui_msg && ui_report !== undefined) {
                ui_report.message("Oops.  It seems something has gone wrong. " +
                                  "Please try reloading the page.",
                                  $("#home-error"), "alert-error");
            }
        }
    });

    if (page_params.save_stacktraces) {
        // Save the stacktrace so it can be examined even in
        // development servers.  (N.B. This assumes you have set DEBUG
        // = False on your development server, or else this code path
        // won't execute to begin with -- useful for testing
        // (un)minification.)
        window.last_stacktrace = stack;
    }
}

function BlueslipError(msg, more_info) {
    // One can't subclass Error normally so we have to play games
    // with setting __proto__
    var self = new Error(msg);
    self.name = "BlueslipError";

    // Indirect access to __proto__ keeps jslint quiet
    var proto = '__proto__';
    self[proto] = BlueslipError.prototype;

    if (more_info !== undefined) {
        self.more_info = more_info;
    }
    return self;
}

BlueslipError.prototype = Object.create(Error.prototype);

exports.exception_msg = function blueslip_exception_msg(ex) {
    var message = ex.message;
    if (ex.hasOwnProperty('fileName')) {
        message += " at " + ex.fileName;
        if (ex.hasOwnProperty('lineNumber')) {
            message += ":" + ex.lineNumber;
        }
    }
    return message;
};

$(window).on('error', function (event) {
    var ex = event.originalEvent.error;
    if (!ex || ex instanceof BlueslipError) {
        return;
    }
    var message = exports.exception_msg(ex);
    report_error(message, ex.stack);
});

function build_arg_list(msg, more_info) {
    var args = [msg];
    if (more_info !== undefined) {
        args.push("\nAdditional information: ", more_info);
    }
    return args;
}

exports.debug = function blueslip_debug (msg, more_info) {
    var args = build_arg_list(msg, more_info);
    logger.debug.apply(logger, args);
};

exports.log = function blueslip_log (msg, more_info) {
    var args = build_arg_list(msg, more_info);
    logger.log.apply(logger, args);
};

exports.info = function blueslip_info (msg, more_info) {
    var args = build_arg_list(msg, more_info);
    logger.info.apply(logger, args);
};

exports.warn = function blueslip_warn (msg, more_info) {
    var args = build_arg_list(msg, more_info);
    logger.warn.apply(logger, args);
    if (page_params.debug_mode) {
        console.trace();
    }
};

exports.error = function blueslip_error (msg, more_info, stack) {
    if (stack === undefined) {
        stack = Error().stack;
    }
    var args = build_arg_list(msg, more_info);
    logger.error.apply(logger, args);
    report_error(msg, stack, {more_info: more_info});

    if (page_params.debug_mode) {
        throw new BlueslipError(msg, more_info);
    }
};

exports.fatal = function blueslip_fatal (msg, more_info) {
    report_error(msg, Error().stack, {more_info: more_info});
    throw new BlueslipError(msg, more_info);
};

// Produces an easy-to-read preview on an HTML element.  Currently
// only used for including in error report emails; be sure to discuss
// with other developers before using it in a user-facing context
// because it is not XSS-safe.
exports.preview_node = function (node) {
    if (node.constructor === jQuery) {
        node = node[0];
    }

    var tag = node.tagName.toLowerCase();
    var className = node.className.length ? node.className : false;
    var id = node.id.length ? node.id : false;

    var node_preview = "<" + tag +
       (id ? " id='" + id + "'" : "") +
       (className ? " class='" + className + "'" : "") +
       "></" + tag + ">";

      return node_preview;
};

window.blueslip = exports;
