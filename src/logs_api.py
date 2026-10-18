import time
from flask import Blueprint, request, jsonify, Response

from logbuffer import get_log_buffer

logs_bp = Blueprint('logs', __name__)

MAX_PAGE = 2000


def _no_store(resp):
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@logs_bp.route('/api/logs')
def api_logs():
    buf = get_log_buffer()
    if buf is None:
        return _no_store(jsonify({
            'epoch': 'disabled', 'entries': [], 'last_seq': 0,
            'skipped': 0, 'capacity': 0, 'persisted': False
        }))

    try:
        after = max(0, int(request.args.get('after', 0)))
    except (TypeError, ValueError):
        after = 0
    try:
        limit = max(1, min(MAX_PAGE, int(request.args.get('limit', MAX_PAGE))))
    except (TypeError, ValueError):
        limit = MAX_PAGE

    client_epoch = request.args.get('epoch') or None
    return _no_store(jsonify(buf.since(after, limit, client_epoch)))


@logs_bp.route('/api/logs/clear', methods=['POST'])
def api_logs_clear():
    buf = get_log_buffer()
    epoch = buf.clear() if buf else None
    return _no_store(jsonify({'status': 'cleared', 'epoch': epoch}))


@logs_bp.route('/api/logs/download')
def api_logs_download():
    buf = get_log_buffer()
    text = buf.export_text() if buf else ''
    stamp = time.strftime('%Y%m%d-%H%M%S')
    resp = Response(text, mimetype='text/plain; charset=utf-8')
    resp.headers['Content-Disposition'] = f'attachment; filename="ytdlp-tube-{stamp}.log"'
    return _no_store(resp)
