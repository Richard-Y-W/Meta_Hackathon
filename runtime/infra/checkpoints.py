"""Sealed checkpoints: canonical JSON state plus its SHA-256. Restore refuses a record whose content does
not match its hash, so a checkpoint cannot be edited (for example to remove or add hidden faults)."""
import hashlib
import json

VERSION = 'lifeline.checkpoint.v1'


class CheckpointError(Exception):
    def __init__(self, code):
        Exception.__init__(self, code)
        self.code = code


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def seal(state):
    frozen = json.loads(canonical(state))  # a copy: later changes to the live state cannot alter the record
    return {'version': VERSION, 'hash': digest(frozen), 'state': frozen}


def unseal(record):
    if not isinstance(record, dict) or record.get('version') != VERSION or 'state' not in record:
        raise CheckpointError('checkpoint_invalid')
    if digest(record['state']) != record.get('hash'):
        raise CheckpointError('checkpoint_corrupt')
    return json.loads(canonical(record['state']))
