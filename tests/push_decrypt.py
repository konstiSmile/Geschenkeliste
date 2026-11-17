"""Gegenprobe für test_push_fn.mjs: entschlüsselt eine Web-Push-Nachricht (RFC 8291) und prüft das VAPID-Token."""
import base64, json, struct, sys
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def ub(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def hkdf(salt, ikm, info, n):
    return HKDF(hashes.SHA256(), n, salt, info).derive(ikm)


c = json.load(open(sys.argv[1]))
priv = ec.derive_private_key(int.from_bytes(ub(c['d']), 'big'), ec.SECP256R1())
ua_pub = priv.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
body = ub(c['body'])
salt, rs, idlen = body[:16], struct.unpack('>I', body[16:20])[0], body[20]
as_pub = body[21:21 + idlen]
shared = priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
ikm = hkdf(ub(c['auth']), shared, b'WebPush: info\x00' + ua_pub + as_pub, 32)
cek = hkdf(salt, ikm, b'Content-Encoding: aes128gcm\x00', 16)
nonce = hkdf(salt, ikm, b'Content-Encoding: nonce\x00', 12)
plain = AESGCM(cek).decrypt(nonce, body[21 + idlen:], None).rstrip(b'\x00')
assert plain[-1:] == b'\x02' and rs == 4096
h, p, s = c['jwt'].split('.')
sig = ub(s)
pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ub(c['vapid']))
pub.verify(encode_dss_signature(int.from_bytes(sig[:32], 'big'), int.from_bytes(sig[32:], 'big')), f'{h}.{p}'.encode(), ec.ECDSA(hashes.SHA256()))
print('ok', plain[:-1].decode())
