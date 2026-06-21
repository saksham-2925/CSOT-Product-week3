"""
tools.py — Tool declarations and execution for the Gemini Live API proxy.

Defines the function-calling schema registered during setup and the
Python functions that run when Gemini issues a toolCall.
"""

import json
from datetime import datetime



TOOL_DECLARATIONS = [
    {
        "function_declarations": [
            {
                "name": "get_current_time",
                "description": "Returns the current local date and time. Use this when the user asks what time it is, the current date, or anything related to the current time.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {},
                    "required": [],
                },
            },
            {
                "name": "get_weather",
                "description": "Returns the current weather for a given location. Use this when the user asks about the weather.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "location": {
                            "type": "STRING",
                            "description": "The city and state/country, e.g., 'San Francisco, CA' or 'London, UK'"
                        }
                    },
                    "required": ["location"],
                },
            }
        ]
    }
]




def get_current_time(**kwargs) -> dict:
    """Return the current local date and time as a formatted string."""
    now = datetime.now()
    return {
        "current_time": now.strftime("%I:%M:%S %p"),
        "current_date": now.strftime("%A, %B %d, %Y"),
        "timezone": now.astimezone().tzname(),
    }

def get_weather(location: str = "Unknown", **kwargs) -> dict:
    """Return mock weather data for the requested location."""
    import random
    conditions = ["Sunny", "Cloudy", "Rainy", "Partly Cloudy", "Clear"]
    temp = random.randint(15, 35) # random temp in Celsius
    return {
        "location": location,
        "temperature_celsius": temp,
        "condition": random.choice(conditions),
        "note": "This is mock data for demonstration purposes."
    }



_TOOL_REGISTRY = {
    "get_current_time": get_current_time,
    "get_weather": get_weather,
}


def execute_tool(name: str, args: dict) -> dict:
    """
    Look up a tool by name and execute it with the provided arguments.

    Returns a dict with the tool's output, or an error message if the
    tool is not found.
    """
    fn = _TOOL_REGISTRY.get(name)
    if fn is None:
        return {"error": f"Unknown tool: {name}"}
    try:
        return fn(**args)
    except Exception as e:
        return {"error": f"Tool '{name}' failed: {str(e)}"}
