#!/usr/bin/env python3
"""
Test script to verify MPS-compatible label handling for YOLO models
"""

import sys
import os
import torch
import numpy as np

# Set up environment for MPS
os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] = '1'
torch.set_default_dtype(torch.float32)
torch.set_default_tensor_type(torch.FloatTensor)

print(f"PyTorch version: {torch.__version__}")
print(f"MPS available: {torch.backends.mps.is_available()}")
print(f"MPS built: {torch.backends.mps.is_built()}")

# Test basic MPS tensor operations
if torch.backends.mps.is_available():
    print("\n=== Testing MPS tensor operations ===")

    # Create a float32 tensor on MPS
    tensor_f32 = torch.randn(10, 10, dtype=torch.float32, device='mps')
    print(f"Created float32 tensor on MPS: shape={tensor_f32.shape}, dtype={tensor_f32.dtype}")

    # Test conversion to numpy
    np_array = tensor_f32.cpu().numpy()
    print(f"Converted to numpy: shape={np_array.shape}, dtype={np_array.dtype}")

    # Test that float64 fails
    try:
        tensor_f64 = torch.randn(10, 10, dtype=torch.float64, device='mps')
        print(f"ERROR: float64 tensor creation should have failed on MPS!")
    except Exception as e:
        print(f"Expected error with float64 on MPS: {e}")

    print("\n=== Testing YOLO model loading ===")

    try:
        from ultralytics import YOLO

        # Try loading a model
        model = YOLO('yolov8n.pt')
        print(f"Loaded YOLO model: {model.__class__.__name__}")

        # Move model to MPS
        if hasattr(model, 'model'):
            model.model = model.model.float().to('mps')
            print("Moved model to MPS with float32")

        # Test set_classes
        print("\n=== Testing set_classes ===")
        test_classes = ['person', 'car', 'dog']

        try:
            if hasattr(model, 'set_classes'):
                model.set_classes(test_classes)
                print(f"set_classes succeeded with: {test_classes}")
        except Exception as e:
            print(f"set_classes failed: {e}")
            print("This is expected on MPS without our wrapper")

        # Test with our wrapper
        print("\n=== Testing MPSCompatibleYOLO wrapper ===")

        # Import the wrapper from vision_realtime_server
        sys.path.insert(0, os.path.dirname(__file__))
        from vision_realtime_server import MPSCompatibleYOLO

        wrapped_model = MPSCompatibleYOLO(model)
        print("Created MPSCompatibleYOLO wrapper")

        try:
            wrapped_model.set_classes(test_classes)
            print(f"Wrapper set_classes succeeded with: {test_classes}")
            print(f"Stored classes: {wrapped_model._custom_classes}")
        except Exception as e:
            print(f"Wrapper set_classes failed: {e}")

        # Test inference (without actual image)
        print("\n=== Testing inference readiness ===")
        print(f"Model device: {wrapped_model.model.device if hasattr(wrapped_model.model, 'device') else 'unknown'}")
        print(f"Model dtype: {next(wrapped_model.model.parameters()).dtype if hasattr(wrapped_model.model, 'parameters') else 'unknown'}")

    except ImportError as e:
        print(f"Ultralytics not installed: {e}")
        print("Install with: pip install ultralytics")
    except Exception as e:
        print(f"Error during YOLO testing: {e}")
        import traceback
        traceback.print_exc()

else:
    print("MPS not available on this system")
    print("This test is designed for Apple Silicon Macs")