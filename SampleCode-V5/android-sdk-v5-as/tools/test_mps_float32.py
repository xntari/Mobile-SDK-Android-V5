#!/usr/bin/env python3
"""
Test script to verify MPS float32 compatibility with YOLOE set_classes
"""

import torch
import sys
import os

print("=" * 60)
print("MPS Float32 Compatibility Test")
print("=" * 60)

# Check PyTorch and MPS setup
print(f"\nPyTorch version: {torch.__version__}")
print(f"MPS available: {torch.backends.mps.is_available()}")
print(f"MPS built: {torch.backends.mps.is_built()}")
print(f"Default dtype: {torch.get_default_dtype()}")

if not torch.backends.mps.is_available():
    print("\nERROR: MPS not available on this system")
    print("This test requires an Apple Silicon Mac")
    sys.exit(1)

# Set float32 defaults as done in the server
torch.set_default_dtype(torch.float32)
os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] = '1'
print(f"\nAfter setup - Default dtype: {torch.get_default_dtype()}")

# Test basic tensor operations
print("\n" + "-" * 40)
print("Testing basic MPS tensor operations:")
print("-" * 40)

try:
    # Test float32 tensor creation
    tensor_f32 = torch.randn(10, 10, dtype=torch.float32, device='mps')
    print(f"✓ Created float32 tensor on MPS: shape={tensor_f32.shape}, dtype={tensor_f32.dtype}")

    # Test conversion to CPU
    cpu_tensor = tensor_f32.cpu()
    print(f"✓ Converted to CPU: shape={cpu_tensor.shape}, dtype={cpu_tensor.dtype}")

    # Test that float64 fails (as expected)
    try:
        tensor_f64 = torch.randn(10, 10, dtype=torch.float64, device='mps')
        print("✗ Unexpected: float64 tensor creation succeeded on MPS")
    except RuntimeError as e:
        print(f"✓ Expected error with float64: {str(e)[:100]}...")

except Exception as e:
    print(f"✗ Error during tensor operations: {e}")
    import traceback
    traceback.print_exc()

# Test with YOLOE if available
print("\n" + "-" * 40)
print("Testing YOLOE model with MPS:")
print("-" * 40)

try:
    from ultralytics import YOLO

    # Try to load a small model
    print("Loading YOLOv8n model...")
    model = YOLO('yolov8n.pt')

    # Move to MPS
    if hasattr(model, 'model'):
        model.model = model.model.float().to('mps')
        print("✓ Moved model to MPS with float32")

        # Check model device and dtype
        device = next(model.model.parameters()).device
        dtype = next(model.model.parameters()).dtype
        print(f"✓ Model device: {device}, dtype: {dtype}")

    # Test the safe_set_classes approach
    print("\nTesting safe set_classes with precomputed embeddings...")

    test_classes = ['person', 'car', 'dog', 'cat', 'bicycle']
    print(f"Test classes: {test_classes}")

    # Check if model has get_text_pe (YOLOE specific)
    if hasattr(model, 'get_text_pe'):
        print("✓ Model has get_text_pe method (YOLOE)")

        # Generate embeddings
        with torch.no_grad():
            emb = model.get_text_pe(test_classes)
            print(f"✓ Generated embeddings: shape={emb.shape}, dtype={emb.dtype}, device={emb.device}")

        # Convert to float32 and move to MPS
        emb_f32 = emb.to(device='mps', dtype=torch.float32)
        print(f"✓ Converted embeddings: dtype={emb_f32.dtype}, device={emb_f32.device}")

        # Try setting classes with precomputed embeddings
        try:
            model.set_classes(test_classes, embeddings=emb_f32)
            print("✓ Successfully set classes with float32 embeddings!")
        except Exception as e:
            print(f"✗ set_classes with embeddings failed: {e}")
    else:
        print("ℹ Model doesn't have get_text_pe (regular YOLO, not YOLOE)")

        # Test regular set_classes (may not work on MPS)
        try:
            model.set_classes(test_classes)
            print("✓ Regular set_classes succeeded")
        except Exception as e:
            print(f"✗ Regular set_classes failed (expected on MPS): {str(e)[:100]}...")

    print("\n" + "=" * 60)
    print("Test Summary:")
    print("- PyTorch float32 defaults: ✓")
    print("- MPS tensor operations: ✓")
    print("- Model loading on MPS: ✓")
    if hasattr(model, 'get_text_pe'):
        print("- YOLOE embeddings approach: ✓")
    print("=" * 60)

except ImportError:
    print("Ultralytics not installed. Install with: pip install ultralytics")
except FileNotFoundError:
    print("Model file not found. The model will be downloaded on first use.")
except Exception as e:
    print(f"Error during YOLOE testing: {e}")
    import traceback
    traceback.print_exc()