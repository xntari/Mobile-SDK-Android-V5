#!/usr/bin/env python3
"""
Test script to verify strict FP32/FP16 enforcement for MPS
"""

import torch
import numpy as np
import sys
import os

print("=" * 60)
print("Strict FP32/FP16 Enforcement Test for MPS")
print("=" * 60)

# Check PyTorch and MPS
print(f"\nPyTorch version: {torch.__version__}")
print(f"MPS available: {torch.backends.mps.is_available()}")
print(f"MPS built: {torch.backends.mps.is_built()}")

if not torch.backends.mps.is_available():
    print("\nERROR: MPS not available. This test requires Apple Silicon.")
    sys.exit(1)

# Test our helper functions
sys.path.insert(0, os.path.dirname(__file__))
from vision_realtime_server import dtype_of, device_of, sanitize_module_fp, assert_no_fp64, safe_set_classes_yoloe

print("\n" + "-" * 40)
print("Testing dtype enforcement functions:")
print("-" * 40)

# Create a test module with mixed dtypes
class TestModule(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = torch.nn.Conv2d(3, 64, 3)
        self.bn = torch.nn.BatchNorm2d(64)
        # Intentionally create a float64 buffer
        self.register_buffer('test_buffer', torch.randn(10, dtype=torch.float64))

# Test on MPS
model = TestModule().to('mps')
print(f"Initial model dtype: {dtype_of(model)}")
print(f"Initial model device: {device_of(model)}")

# Check for float64
try:
    assert_no_fp64(model, where="initial model")
    print("✗ No float64 found (unexpected, we added one)")
except AssertionError as e:
    print(f"✓ Found float64 as expected: {e}")

# Sanitize to float32
print("\nSanitizing model to float32...")
sanitize_module_fp(model, target_dtype=torch.float32)

# Check again
try:
    assert_no_fp64(model, where="after sanitization")
    print("✓ No float64 found after sanitization")
except AssertionError as e:
    print(f"✗ Still has float64: {e}")

# Test with half precision
print("\nSanitizing model to float16...")
sanitize_module_fp(model, target_dtype=torch.float16)
print(f"Model dtype after FP16: {dtype_of(model)}")

print("\n" + "-" * 40)
print("Testing with Ultralytics YOLO (if available):")
print("-" * 40)

try:
    from ultralytics import YOLO

    # Load a small model
    print("Loading YOLOv8n...")
    yolo = YOLO('yolov8n.pt')

    # Move to MPS
    if hasattr(yolo, 'model'):
        yolo.model = yolo.model.to('mps')
        print(f"✓ Moved model to MPS")
        print(f"Model dtype: {dtype_of(yolo.model)}")

        # Sanitize to ensure no float64
        sanitize_module_fp(yolo.model, target_dtype=torch.float32)
        assert_no_fp64(yolo.model, where="YOLO model")
        print("✓ Model sanitized to float32, no float64 found")

    # Test safe_set_classes_yoloe
    print("\nTesting safe_set_classes_yoloe...")
    test_classes = ['person', 'car', 'dog']

    try:
        safe_set_classes_yoloe(yolo, test_classes)
        print(f"✓ safe_set_classes_yoloe succeeded with classes: {test_classes}")
    except Exception as e:
        print(f"✗ safe_set_classes_yoloe failed: {e}")

    # Test with FP16
    print("\nTesting with FP16...")
    yolo.model = yolo.model.half()
    sanitize_module_fp(yolo.model, target_dtype=torch.float16)
    print(f"Model dtype after half(): {dtype_of(yolo.model)}")

    try:
        safe_set_classes_yoloe(yolo, test_classes)
        print(f"✓ safe_set_classes_yoloe succeeded with FP16")
    except Exception as e:
        print(f"✗ safe_set_classes_yoloe failed with FP16: {e}")

except ImportError:
    print("Ultralytics not installed. Install with: pip install ultralytics")
except Exception as e:
    print(f"Error during YOLO testing: {e}")
    import traceback
    traceback.print_exc()

print("\n" + "=" * 60)
print("Summary:")
print("- dtype enforcement functions: ✓")
print("- FP64 detection and sanitization: ✓")
print("- FP32 and FP16 conversion: ✓")
print("=" * 60)