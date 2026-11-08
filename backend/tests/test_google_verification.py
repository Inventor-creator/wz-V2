"""Verify the real Google verifier boundary, without fetching Google keys."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from google.auth import crypt, jwt
from google.auth.exceptions import GoogleAuthError


class GoogleVerificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Ephemeral test keys only; never used for real Google identities.
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
        cls.signer = crypt.RSASigner.from_string(pem, key_id='test-key')
        cls.public_key = key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode()

    def setUp(self):
        spec = importlib.util.spec_from_file_location('google_auth_service_under_test',Path(__file__).parents[1]/'authService.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_uses_supported_google_verifier_and_expected_audience(self):
        with patch.dict(os.environ,{'GOOGLE_CLIENT_ID':'expected-client'}), patch.object(self.module.id_token,'verify_oauth2_token',return_value={'email_verified':True}) as verify:
            self.module.verify_google_id_token('signed-token')
            self.assertEqual(verify.call_args.kwargs['audience'],'expected-client')
            self.assertEqual(verify.call_args.args[0],'signed-token')

    def test_rejects_invalid_signature_issuer_audience_and_expiry(self):
        for failure in ['signature','issuer','audience','expiry']:
            with self.subTest(failure=failure), patch.dict(os.environ,{'GOOGLE_CLIENT_ID':'expected-client'}), patch.object(self.module.id_token,'verify_oauth2_token',side_effect=ValueError(failure)), self.assertRaises(ValueError):
                self.module.verify_google_id_token('invalid-token')

    def test_rejects_unverified_email_and_wrong_authorized_party(self):
        for claims in [{'email_verified':False},{'email_verified':True,'azp':'other-client'}]:
            with self.subTest(claims=claims),patch.dict(os.environ,{'GOOGLE_CLIENT_ID':'expected-client'}),patch.object(self.module.id_token,'verify_oauth2_token',return_value=claims),self.assertRaises(ValueError):
                self.module.verify_google_id_token('token')

    def signed_token(self, **changes):
        now = int(time.time())
        claims = {'iss':'https://accounts.google.com','aud':'expected-client','iat':now-10,'exp':now+600,'sub':'fixture-subject','email':'fixture@example.com','email_verified':True,**changes}
        return jwt.encode(self.signer,claims).decode()

    def test_real_google_library_accepts_valid_signed_fixture(self):
        with patch.dict(os.environ,{'GOOGLE_CLIENT_ID':'expected-client'}),patch.object(self.module.id_token,'_fetch_certs',return_value={'test-key':self.public_key}):
            claims=self.module.verify_google_id_token(self.signed_token())
            self.assertEqual(claims['sub'],'fixture-subject')

    def test_real_google_library_rejects_bad_claims_and_signature(self):
        invalid = [self.signed_token(iss='https://attacker.example'), self.signed_token(aud='wrong-client'), self.signed_token(iat=int(time.time())-500,exp=int(time.time())-100),self.signed_token(email_verified=False)]
        parts=self.signed_token().split('.')
        parts[2]=('A' if parts[2][0]!='A' else 'B')+parts[2][1:]
        invalid.append('.'.join(parts))
        for index,raw in enumerate(invalid):
            with self.subTest(case=index),patch.dict(os.environ,{'GOOGLE_CLIENT_ID':'expected-client'}),patch.object(self.module.id_token,'_fetch_certs',return_value={'test-key':self.public_key}),self.assertRaises((ValueError,GoogleAuthError)):
                self.module.verify_google_id_token(raw)
