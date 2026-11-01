"""Unprivileged infrastructure worker transport: newline-delimited JSON over stdio.

Request {v, id, cmd, args}; reply {v, id, workerSeq, ok, result | error: {code, detail}}. Same framing as
the network worker (runtime/mininet/worker.py) without sockets or privilege. Results are strict JSON:
NaN or infinity in a result is a worker error, never a silent value.
"""
import json
import sys

PROTOCOL = 1
MAX_FRAME = 16 << 20


class Rejected(Exception):
    def __init__(self, code, detail=''):
        Exception.__init__(self, '%s: %s' % (code, detail))
        self.code, self.detail = code, detail


def handle(handlers, line, seq):
    """One frame -> one reply dict. Never raises."""
    request_id = None
    try:
        if len(line) > MAX_FRAME:
            raise Rejected('frame_too_large', str(len(line)))
        try:
            request = json.loads(line)
        except ValueError:
            raise Rejected('invalid_frame', 'not JSON')
        if not isinstance(request, dict):
            raise Rejected('invalid_frame', 'not an object')
        request_id = request.get('id')
        if request.get('v') != PROTOCOL:
            raise Rejected('protocol_mismatch', str(request.get('v')))
        if not isinstance(request_id, int) or isinstance(request_id, bool):
            raise Rejected('invalid_frame', 'id')
        args = request.get('args', {})
        if not isinstance(args, dict):
            raise Rejected('invalid_frame', 'args')
        command = handlers.get(request.get('cmd'))
        if command is None:
            raise Rejected('unknown_command', str(request.get('cmd')))
        result = command(args)
        json.dumps(result, allow_nan=False)
        return {'v': PROTOCOL, 'id': request_id, 'workerSeq': seq, 'ok': True, 'result': result}
    except Rejected as error:
        return {'v': PROTOCOL, 'id': request_id, 'workerSeq': seq, 'ok': False, 'error': {'code': error.code, 'detail': error.detail}}
    except ValueError as error:
        return {'v': PROTOCOL, 'id': request_id, 'workerSeq': seq, 'ok': False, 'error': {'code': 'nonfinite_result', 'detail': str(error)[:200]}}
    except Exception as error:  # a worker defect is reported, not hidden
        return {'v': PROTOCOL, 'id': request_id, 'workerSeq': seq, 'ok': False, 'error': {'code': 'worker_error', 'detail': '%s: %s' % (type(error).__name__, str(error)[:300])}}


def serve(handlers, instream=None, outstream=None):
    instream, outstream = instream or sys.stdin, outstream or sys.stdout
    seq = 0
    for line in instream:
        if not line.strip():
            continue
        seq += 1
        reply = handle(handlers, line, seq)
        outstream.write(json.dumps(reply, allow_nan=False, separators=(',', ':')) + '\n')
        outstream.flush()
        if reply['ok'] and json.loads(line).get('cmd') == 'shutdown':
            break
